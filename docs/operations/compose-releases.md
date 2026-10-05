# Compose application releases

UseAgent uses the same immutable backend, gateway, and frontend images for local
parity, the single Hetzner application host, and the later Kubernetes lane.
CubeSandbox is infrastructure outside these Compose projects.

## Local parity

```bash
cp deploy/compose/env.example .env.compose
# Replace every placeholder and set RELEASE_COMMIT to `git rev-parse HEAD`.
docker compose --env-file .env.compose -f compose.local.yaml up --build
```

The local project owns only disposable/development PostgreSQL and application
volumes. Set `SANDBOX_PROVIDER=daytona` with a development Daytona key, or point
the containers at a Cube Linux development VM. macOS Docker does not replace
Cube's Linux VM/kernel requirements.

`GATEWAY_PUBLIC_URL` must be an HTTPS origin reachable from the external
sandbox. A Docker service name is neither a valid public gateway origin nor
resolvable from Daytona/Cube. Use a development tunnel or a real development
gateway domain; do not weaken the production URL validator.

## Hetzner candidate project

`compose.prod.yaml` accepts only caller-supplied image references. The private
release orchestrator must run `bun deploy/compose/validate-release.ts` and pass
the validated registry digests, not mutable tags, into Compose:

```text
ghcr.io/useagenthq/backend@sha256:...
ghcr.io/useagenthq/gateway@sha256:...
ghcr.io/useagenthq/frontend@sha256:...
```

It must also set `USEAGENT_GATEWAY_PUBLIC_URL` to the credential-free HTTPS
origin reachable by tenant sandboxes. Candidate validation rejects HTTP,
credentials, paths, query strings, and fragments before Compose starts.

Blue and green projects use separate loopback ports. Frontend and gateway
candidates may overlap where their database/runtime contracts permit, but the
backend may not: provider sealing and realtime fan-out remain process-local and
`REQUIRE_SINGLE_BACKEND=true` must stay enabled.

## Promote a release

`deploy/promote.ts` is the production release path. It runs from an operator
machine, or from the `promote.yml` workflow, over SSH. It consumes the
`release-manifest.json` that `images.yml` publishes for a `main` commit (the
commit plus three digest-pinned images) and promotes those digests side by
side. The operator environment is the one documented in
`systemd-compose-adoption.md`: `USEAGENT_PROMOTE_HOST`,
`USEAGENT_PROMOTE_APP_DOMAIN`, `USEAGENT_PROMOTE_GATEWAY_DOMAIN`, and an SSH
key or SSH config.

```bash
bun run deploy/promote.ts promote --manifest release-manifest.json
```

With admission open, the command pulls the images by digest, checks that every
image revision matches the manifest commit, classifies the migration set as
expansion-safe, runs the migration one-shot, and starts the inactive-color
frontend and gateway beside the live ones on their own loopback ports.
Admission then closes for at most 30 seconds: drain the live backend for at
most 10 seconds, stop it, start the candidate backend on the inactive-color
port, verify its loopback fingerprint, validate and reload Caddy onto the new
color, verify the three public fingerprints, commit the release history, and
reopen admission. The previous color's frontend and gateway stop last. The
command is bounded to five minutes end to end and holds the host promotion
lock (`promote.lock` under the state root) throughout, so two promotions never
overlap. Nothing is built or synchronized on the host.

A failure before admission closes stops the staged edge and changes nothing
else. A failure after it compensates back to the previous release before
admission reopens. A `failed-closed` history is recovered by rerunning the same
command. `bun run deploy/promote.ts rollback` flips to the recorded previous
release without pulling or migrating anything: it stops the candidate backend,
restarts the prior backend, verifies its loopback health, then reverses Caddy
and reopens admission. Never disable the single-backend guard to simulate
overlapping blue/green backends.

Flags:

- `--skip-gates` (default) promotes without provider certification. This is
  the fast path: no source sync, no parity preflight, no evidence cache, no
  paid runs.
- `--gates` runs the operator-side post-promotion canaries inline once the
  release is live and admission is open: `product-child-post-promotion-smoke.ts`,
  `hosted-release-canary.ts` in its post-promotion phase, then
  `advertised-model-canary.ts`. They need `USEAGENT_COOKIE_FILE`; the public
  origin is derived from `USEAGENT_PROMOTE_APP_DOMAIN`. The first failure rolls
  the release back through the controller's own `rollback` and the command
  exits nonzero. The host-side parity matrix never runs inline.
- `--drain` (default) waits up to 10 seconds for in-flight runs before the
  backend swap. `--no-drain` skips only that wait; admission still closes for
  the swap window and the candidate backend's boot recovery reconciles the
  runs that were interrupted.

The final stdout line is one JSON object with `status`, `gates`, `drain`, and
the timing metrics; gate output goes to stderr.

Certification on demand and on a schedule lives in the `gates.yml` workflow. It
runs the full canary matrix against the promoted release and reports the
rollback command instead of gating the promotion. `promote.yml` wraps the
command above for a chosen `main` commit.

Do not run an in-place `docker compose up` against the active color as a release
procedure. Do not include Cube, host PostgreSQL, memory, OpenConnector, or Caddy
in the application project.

The gateway environment must contain only gateway-owned configuration. Current
computer/recording/repository tools still need the single deployment-selected
sandbox provider credential; configure only that active provider's key and
endpoint/template fields. Never place both Cube and Daytona control credentials
in the gateway environment, and never copy the backend environment wholesale.

The gateway does need `GATEWAY_DATABASE_URL`, `USEAGENT_API_ORIGIN` (the
backend origin it forwards child-session, handoff and approval tool calls to),
`FRONTEND_ORIGIN`, the three shared secrets, `GATEWAY_PUBLIC_URL`, and the same
`PRODUCT_CHILD_THREADS` and `BOTS` values as the backend. The tool families it
advertises follow the backend's `GET /api/config` `product` block, refreshed
once a minute; while its own flags disagree it logs an error naming both values,
and while the backend is unreachable it falls back to its own flags with a
warning.
