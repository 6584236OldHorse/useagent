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

## Gates on demand

The certification that `deploy/hetzner/release-gate.sh` ran inline during a
promotion (and that held run admission closed for the whole matrix) is
available as `.github/workflows/gates.yml`: one job per gate family, run
against whatever is live at `sha`. A promotion is fast by default;
`promote.yml` calls `gates.yml` with `readiness,canary` afterwards and adds
`parity` only when its `parity` input is true. Every job refuses to start, and
refuses to pass, unless the public `/healthz` body and the backend
`x-useagent-release-fingerprint` header report exactly `sha`. No job deploys,
writes under `/opt/useagent` or `/etc/useagent`, or takes the deploy lock; a
promotion during a gate fails that gate at its closing commit check.

| Gate | Runs | Cost | Time |
| --- | --- | --- | --- |
| `readiness` (default) | release contracts, canary cookie, product-child catalog, loopback operator bridge, provider readiness | no sandbox runs; one "Reply exactly OK" request per engine | about 5 min |
| `canary` (default) | `hosted-release-canary.ts` preflight and post-promotion phases | one Codex run, upload scanner, automation create/delete | about 10 min |
| `models` | `advertised-model-canary.ts` | one bounded run per advertised OpenCode model (11 paid plus the free lane) | about 15 min |
| `lifecycle` | Pi cancel and the four-harness product-child family; Claude cutover, approval, question and cancel when `RELEASE_RUNTIME_ENGINES` includes `claude` | about 17 runs, plus 4 Claude runs | about 15 min |
| `parity` | `t3-parity-canary.ts` over 19 cases for claude, codex and opencode plus 4 Pi cases, then a `release-readiness.ts` dry run | 61 real runs, fewer on resume | 60 to 90 min |
| `desktop` | `t3-hosted-cutover-canary.ts` (Playwright; needs Google Chrome on the runner) | one Codex run with a desktop | about 5 min |

Host-side gates (`readiness`, `lifecycle`, `parity`) rsync the exact commit
into `/var/lib/useagent/gates/<gate>-<sha12>/`, install its locked backend and
package dependencies there, run the canaries with `/etc/useagent/backend.env`
(and `gateway.env` where the inline gate did), and remove the directory when
done. The host needs `bun` on its PATH. Compose colors are honoured: the
active backend's loopback port is read from `release-history.json` and passed
to the canaries as `USEAGENT_LOOPBACK_ORIGIN`.

Run it from Actions (Release gates, Run workflow) or with
`gh workflow run gates.yml -f sha=<sha> -f gates=readiness,canary,parity`.
Each job uploads `gate-<name>-<sha>` (logs, `candidate.json` and its cache
manifest, Pi evidence, and the readiness lines the evidence would promote) and
writes a pass/fail step summary. To resume a parity matrix that failed within
the last six hours, pass `evidence_run_id=<that run's id>`; only rows that did
not pass are re-run.

The same script runs one family from an operator machine:

```bash
USEAGENT_SSH_KEY=<key> USEAGENT_SSH_HOST=root@<host> \
USEAGENT_COOKIE_FILE=<netscape cookie jar> CANARY_ORG_ID=<org> CANARY_USER_ID=<user> \
  bash deploy/hetzner/live-release-gate.sh parity
```

Production environment secrets: `USEAGENT_DEPLOY_SSH_KEY`,
`USEAGENT_DEPLOY_KNOWN_HOSTS`, `USEAGENT_DEPLOY_HOST`,
`USEAGENT_CANARY_COOKIE`, `USEAGENT_CANARY_ORG_ID`, `USEAGENT_CANARY_USER_ID`
and, for `desktop`, `USEAGENT_CANARY_EMAIL`. Variables: `USEAGENT_APP_DOMAIN`
and `RELEASE_RUNTIME_ENGINES`. Everything else a canary reads comes from
`/etc/useagent` on the host.
