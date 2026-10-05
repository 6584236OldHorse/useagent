# Frontend performance measurement

Lab measurements of the production build, the way the 2026-09 numbers in AGENTS.md
and the perf PRs were taken. Nothing here runs in CI; run it by hand before and after
a change and put both numbers, with these conditions, in the PR body.

## Stack

1. A throwaway database on port 5433 (never psql on this machine):
   `cd backend && TEST_ADMIN_URL=postgres://postgres@localhost:5433/postgres TEST_DATABASE_URL=postgres://postgres@localhost:5433/perf_<random> bun run test/prepare-db.ts`
2. A backend on a free port above 3600 against it:
   `cd backend && PORT=3611 DATABASE_URL=postgres://postgres@localhost:5433/perf_<random> ALLOW_DEV_ORG=1 FRONTEND_ORIGIN=http://localhost:3620 bun src/index.ts`
   (never a shared database: boot recovery would reconcile other processes' runs).
3. A production build whose `/api/*` rewrite points at that backend. The rewrite target is
   baked at build time from `USEAGENT_API_ORIGIN`:
   `cd frontend && USEAGENT_API_ORIGIN=http://localhost:3611 bun run build`
   then `USEAGENT_API_ORIGIN=http://localhost:3611 bunx next start -p 3620`.
   `next start` warns about `output: standalone` and serves anyway.
4. Fixtures: the mock engine seeds runs but writes no native or canonical events. Seed a
   settled thread directly through the backend's repo functions (createRun, insertStep,
   recordProviderEvent, persistAndPublish, an outbox row in state complete) sized to a
   read-only probe of production, and say so in the numbers.

The scripts sign in with a cookie named `better-auth.session_token` whose value does
not matter: `proxy.ts` checks presence, and a backend with `ALLOW_DEV_ORG=1` serves the
dev org. They use the system Chrome through `playwright-core` (`channel: "chrome"`).

## Scripts (run from `frontend/`)

- `bun run perf:routes` (after `bun run build`): first-load JavaScript per route from the
  build's client reference manifests, raw and gzip. This is the figure the budget in
  AGENTS.md is written against. Chunks a `next/dynamic` boundary loads are not in it.
- `bun run analyze -- -o` (after a build): the Turbopack
  bundle analyzer's import chains, written under the build directory; without `-o` it
  opens its web UI.
- `bun test/perf/page.ts <origin> <path> [runs]`: one route, cold cache per run: TTFB,
  FCP, LCP, TBT, CLS (single-session lab values from PerformanceObserver), JS transfer,
  the API request log with duplicates, and the thread-events SSE bytes counted over CDP
  (an open EventSource never lands in resource timing). Median and range over the runs.
- `bun test/perf/reconnect.ts <origin> <threadA> <threadB> [runs]`: open A, soft-navigate
  to B through the sidebar, come back: the SSE bytes of the first open and of the return
  (the retained store's reconnect with its cursors).
- `bun test/perf/lazy-panes.ts <origin> <threadId> <Tab,Tab>`: the JS chunks requested
  when a rail tab is first opened (Details, Diff, Browser).
- `bun test/perf/warm.ts <origin> <firstPath> <hop,hop>`: what the idle route prefetch
  and chunk warming download after the first page, and whether the hops after it find
  their chunks in the cache.
- `bun test/perf/nav-spend.ts <origin> <threadId> [runs]`: time from a client-side
  navigation into a thread to the spend chip's read.

## Reporting

Name the metric as the performance skill does (LCP, TBT, FCP as lab values; bytes on the
wire), state the conditions (headless Chrome version, viewport, no throttling, cold cache
per run, dev-org session, the fixture), give the median with the range over at least
three runs, and keep before and after on the same fixture state. The first navigation
right after a `next start` restart can replay a thread in full; discard that run.
