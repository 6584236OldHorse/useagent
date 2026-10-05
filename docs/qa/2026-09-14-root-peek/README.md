# Root conversation peek semantics

## Live reproduction

Reload All threads, find the QA controls-only root conversation, and choose Peek run. The deployed pane calls the root a Subagent and offers Pass instructions down. `before.png` captures the current live reproduction.

Ordinary replies also have `parent_run_id`; that field does not prove that a run is a gateway child. The authoritative discriminator is decoded `child_session === true`.

## Fix and checks

- Root runs and ordinary replies show Session and Open thread, not child-only controls.
- Real gateway children retain Subagent and the pass-down composer.
- Unknown code-split loading is neutral Run; caller-known loading/error metadata remains supported.
- Fetched run data, not a caller hint, controls available child actions.
- Six rendering/selection tests pass; pinned TypeScript 5.9 full-root check, targeted lint, full frontend lint and production build pass. The existing route-chunks filesystem tracing warning remains unchanged.
- Independent code review APPROVE and architecture CLEAR. Post-review cleanup shares the identical footer wrapper and introduces no behavior change or dependency.

`after-dark.png` and `after-light.png` show the actual patched LoadedPane component rendered with production CSS and synthetic root/child data in Chrome. The isolated fixture uses a fallback font and no hydration/backend. These screenshots prove the visual classification and control split, not a deployed navigation or pass-down test. The temporary generator was removed; generated HTML evidence is retained in the QA directory.

## Bundle measurement

Compared separate production builds of unchanged frontend commit `6a43a9f53` and this patch using the repository's manifest/rootMainFiles aggregation and gzip sizing:

| Route | Before gzip bytes | After gzip bytes | Delta |
|---|---:|---:|---:|
| /agent/runs | 448,733 | 448,812 | +79 |
| /session/[id] | 629,821 | 629,900 | +79 |
| /bots | 661,303 | 661,382 | +79 |

All measured routes increased by 79 bytes in these builds; the largest remains below the documented 660 KiB ceiling. The rounded runs-page measurement stays 438 KiB, but this is not a zero-byte-growth claim. No source/data fetching or stream behavior was changed.

No merge, deployment, credentials, or existing user files were changed by this audit. CI remains the final repository-wide gate.
