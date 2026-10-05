# T3 upstream tracking

UseAgent runs a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) inside every
sandbox as the agent runtime. This file is the log of which upstream version we run, what our fork
changes, and how to take the next upstream release. Update the log table on every runtime change.

## What we run now

| Item | Value |
|---|---|
| Upstream base | `f391794a35` on t3code `main`, nightly `v0.0.46-nightly.20261003.2632` (orchestrator V2) |
| Fork head | `dd2b1389590f` (branch `useagent-v2`; bundle and patch attached to the release) |
| Runtime release | `native-runtime-dd2b1389590f` (pro and public `useagenthq/useagent`) |
| Pins in `third_party/t3code-fork.lock` and `backend/runtime-assets/manifest.json` | contract `orchestrator-v2-hosted-codex-host-switches-v7` |
| Engines | Codex `0.159.3`, Claude Code `2.1.285`, OpenCode `@opencode/cli 2.0.18` (installed with `--trust`), Pi (bypasses T3) |
| Runtime generation | `useagent-runtime-v9`, the image default (compose blanks any host env pin, so each image brings its own) |

## What our fork changes

Every item is a commit on `useagent-v2`. Re-port each one when rebasing; upstream rewrites often
move the code they touch.

1. Cursor driver removed (drops the `@cursor/sdk` runtime dependency); `fff-node` imported statically.
2. `T3_PROVIDER_MCP=off`: sessions start with `configureMcp: false`, so agents never get T3's own
   thread tools (create threads, schedules, forks) that would bypass our backend.
3. `T3_PROVIDER_CONTINUATIONS=off`: T3 never starts a run by itself (background-job wakes,
   continuations); every run goes through our admission and spend checks.
4. `T3_PROVIDER_INSTRUCTIONS=off`: no "you are running in T3 Code" or PR-linking text in agent
   instructions; our backend writes the preamble.
5. Hosted Codex through our relay: WebSocket transport in `CodexAppServerClientFactory.open`, no
   `config` on hosted thread calls, turn environments on `turn/start`, required-MCP wait on a
   thread's first turn only.
6. OpenCode 2 model loader waits up to 20 s for a cold catalog (upstream gave up after 5 s).
7. Version string reports the pinned nightly.
8. Telemetry: `T3CODE_TELEMETRY_ENABLED=false` is set by our launch env, not a fork change.

Known gap in `dd2b1389590f`: `packages/effect-codex-app-server/src/client.ts` encodes `turn/start`
with a schema that has no `environments` field, so item 5's turn environments never reach the wire.
The relay fills in the run's environment when a turn arrives without one
(`codex-subscription-protocol.ts`). Fix the client schema on the next fork build and keep the relay
fallback.

## What our backend depends on (the wire)

The driver translates V2 at one edge (`backend/src/engines/runtime-v2-view.ts`) into the shapes the
rest of the backend and the frontend already use. It speaks:

- WebSocket RPC with `?orchestrationProtocol=2`: `orchestration.subscribeThread`,
  `orchestration.dispatchCommand` (`message.dispatch`, `run.interrupt`, `runtime-request.respond`,
  `provider-session.detach`), `server.refreshProviders`.
- HTTP: `/.well-known/t3/environment` (protocol check, fails closed unless 2),
  `/threads/:id/bounded` with header `x-t3-orchestration-protocol: 2`, `/api/projects/mutate`.

Upstream changes to these are the ones that break us. Watch `apps/server` orchestration contracts,
`CodexAdapterV2` and the app-server client, the OpenCode and Claude adapters,
`ProviderSessionManager` (`configureMcp`), `ProviderContinuationRequests`, `buildRuntimeInstructions`
and the model manifest.

## Taking a new upstream release

1. Fetch upstream, rebase `useagent-v2` onto the chosen ref, re-port the fork items above.
2. Run the fork's server suite and typecheck; failures that also fail on clean upstream are environmental.
3. Package with `deploy/t3/package-runtime.sh <fork checkout> <outdir>`; make the patch
   (`git diff <base> HEAD`) and bundle (`git bundle create ... <base>..useagent-v2`).
4. Scan the archive and patch for secrets, internal hosts and personal data; publish a new
   `native-runtime-<sha12>` release on pro (archive, bundle, patch) and public (archive, patch).
   Never overwrite an asset; never mark it latest.
5. Point `backend/runtime-assets/manifest.json`, `third_party/t3code-fork.lock`, the Dockerfile
   checks and the engine pins at the release; run the backend suite.
6. Merge to main (auto-deploys), bake the sandbox image from the promoted backend image
   (`deploy/hetzner/bake-native-images.sh`), build the E2B template under its unique image tag
   (E2B reuses its cache when a tag is reused), set `CUBE_TEMPLATE_ID` and
   `RUNTIME_CUBE_TEMPLATE_ID` in both `backend.env` and `gateway.env`, bump the code default
   `DEFAULT_RUNTIME_GENERATION` in `runtime-environment.ts` when the wire changes (compose ignores
   the host env value), and recreate backend and gateway.
7. Smoke one turn per engine (Codex subscription, Codex key, Claude, OpenCode). Fix forward.

## Log

| Date | Upstream | Fork | Release | Template | Notes |
|---|---|---|---|---|---|
| 2026-10-03 | v0.0.45 | `762f4b14b328` | `native-runtime-762f4b14b328` | `6kkpyffstib7km2vrwjt` | last pre-V2 runtime; telemetry off; Chromium locked down |
| 2026-10-04 | nightly 20261003.2632 (`f391794a35`) | `dd2b1389590f` | `native-runtime-dd2b1389590f` | `3y8my0mv4fmnr4tkaq2k` | orchestrator V2 switch: WebSocket commands, native subagents, OpenCode 2, Claude 2.1.285 |
