# Immutable OCI release lane

This is the additive first phase of the v0.0.2 release-path migration. It builds
three independent OCI images from one committed Git SHA:

- `ghcr.io/useagenthq/backend:sha-<12-character-git-sha>`
- `ghcr.io/useagenthq/gateway:sha-<12-character-git-sha>`
- `ghcr.io/useagenthq/frontend:sha-<12-character-git-sha>`

The backend and gateway use Bun 1.3.14 from a pinned multi-platform digest. The
frontend uses Bun only for its frozen install, then builds and runs the compact
Next standalone server on pinned Node 24. Secrets are not build arguments and
are not copied into an image. Every image carries
`org.opencontainers.image.revision`; the backend and gateway expose the same SHA
through the release-fingerprint response header, and the frontend exposes it at
`GET /healthz`.

## Build and prove locally

Docker must be running. The smoke test builds all three images, starts an
ephemeral pgvector database, runs the release migration in a one-shot backend
container, starts the three services, verifies health, and verifies all release
fingerprints:

```bash
scripts/smoke-oci.sh
```

Build the exact committed SHA for the production `linux/amd64` architecture:

```bash
scripts/build-oci.sh load
```

After authenticating Docker to GHCR, publish those same immutable tags:

```bash
USEAGENT_OCI_REGISTRY=ghcr.io/useagenthq scripts/build-oci.sh push
```

The script refuses a dirty tracked worktree. It never publishes `latest`.

## Kamal 2 configuration

Kamal 2.12 or newer reads the shared configuration and one required destination:

```bash
export USEAGENT_DEPLOY_HOST=<host>
export USEAGENT_REGISTRY_USER=<registry-user>
export KAMAL_REGISTRY_PASSWORD=<registry-token>

kamal config -d backend
kamal config -d gateway
kamal config -d frontend
```

The destinations deliberately preserve the current host boundary:

- Caddy stays host-managed.
- PostgreSQL stays host-managed and reaches the backend through host networking.
- memory and OpenConnector remain external services configured by the existing
  `/etc/useagent/backend.env`.
- the restricted gateway continues to receive both
  `/etc/useagent/backend.env` and `/etc/useagent/gateway.env`.
- artifact, run scratch, Slack upload, and Pi runtime paths retain their current
  host directories.

The database migration is separate from app boot:

```bash
kamal app exec -d backend --primary --version <git-sha> "bun run migrate:release"
```

## Cutover boundary

Production promotes through the Compose lane (`deploy/promote.ts`, see
`compose-releases.md`); do not invoke `kamal deploy` against production. These
phase-one destinations use host networking and the existing fixed loopback
ports so Caddy does not change. A candidate container therefore cannot overlap
the existing systemd service on the same port.

The production cutover remains blocked until the private release orchestrator:

1. closes and drains run admission under an operation id;
2. verifies the three SHA-tagged images and runs the one-shot migration;
3. stops the matching systemd service before each destination cutover;
4. deploys with `--skip-push --version <git-sha>` so nothing rebuilds;
5. executes the existing parity and release gates;
6. reopens admission only after all three live fingerprints match; and
7. restores the prior SHA-tagged images before reopening admission on failure.

True overlapping, gapless replacement requires a later Caddy-to-kamal-proxy
loopback handoff. That routing change belongs to private operations and is not
part of this additive public-repository phase.

## Promote from GitHub

The `Promote` workflow (`.github/workflows/promote.yml`, run it from the
Actions tab) ships a release that `images.yml` already published, in about a
minute, from a Blacksmith runner. It takes the `release-manifest-<sha>`
artifact from the successful `images.yml` push run on `main` for that sha,
checks that the three digests exist in GHCR, and runs
`bun run deploy/promote.ts` over ssh. That controller owns the host promotion
lock, admission close and reopen, the backend swap, the migration one-shot,
the Caddy switch and compensation on failure; the workflow only adds the
loopback health checks on the host and `https://<app domain>/healthz` from
the runner (HTTP 200 with the live commit, 60 s each), then a step summary
with the commit, color, status and timings. The controller, `compose.prod.yaml`
and the Caddy template always come from the revision the workflow runs from;
the requested sha is release data only.

Inputs:

- `sha`: the main commit to promote. Its images.yml run must have published
  the manifest artifact (90 day retention). Leave it empty for a rollback.
- `rollback` (default false): run the controller's `rollback`, which restores
  the release the host recorded as previous under the host lock; no migration
  runs. To reach any other older sha, promote it: the controller accepts only
  a forward-safe migration set and always runs the migration one-shot, so
  there is no migrate switch.
- `drain` (default true): wait up to 10 s for in-flight runs before the swap.
- `parity` (default false): call `gates.yml` (readiness, canary, parity) after.

Secrets (on the `production` environment or the repository):
`USEAGENT_DEPLOY_SSH_KEY` (private key; the controller connects as root),
`USEAGENT_DEPLOY_KNOWN_HOSTS` (`ssh-keyscan` output for the host) and
`USEAGENT_DEPLOY_HOST` (bare host name or address). Variables:
`USEAGENT_GATEWAY_DOMAIN` (required) and `USEAGENT_APP_DOMAIN` (default
`app.useagent.org`). The host pulls from GHCR with the login `configure-host.sh`
created; the runner needs only `GITHUB_TOKEN` (`packages: read`) for the
digest check.

If a run stops without a final status line, rerun it with the same inputs: the
first rerun recovers the pending operation and exits with `retryRequired`, the
second one promotes.
