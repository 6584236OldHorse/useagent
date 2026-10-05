# Durable Chat attachment audit

## Reproduction

In the no-sandbox Chat surface, upload a synthetic screenshot of a counter and ask for its visible number and button labels. The run claims the upload, but the original worker constructs only system text and the current prompt. No image bytes reach the provider.

The captured live run also returns the generic message `chat request failed`. A later scoped read-only OpenRouter key-status check confirmed HTTP 401 with an expiry error for the unchanged selected credential. This is separate from missing-image forwarding. After the user replaced the key, the status check returned 200 and the same Chat thread completed a text reply successfully; image forwarding remains absent in the deployed worker.

The before-fix screenshot (the synthetic image attached to the user message beside the generic failure) is posted on pull request #346, not kept in the repository.

## Fix contract

- Only durable Chat runs gain file inputs. Native engine/sandbox paths remain unchanged; the legacy `/api/chat` request remains string-only.
- Current files and files from precisely the selected prior turns are read from claimed, organization/thread-scoped uploads. Future queued turns and trimmed history are excluded.
- Files are user data with explicit current/historical attribution. This framing is not a guarantee against model prompt injection.
- Validate supported type, count, byte budgets, actual bytes, digest, and image signature before provider dispatch. Do not materialize a sandbox for Chat.
- PNG, JPEG, WebP and GIF follow [OpenRouter's image-input format](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding). Provider-neutral image bytes become data URIs only at the OpenRouter request boundary.
- Local product caps: 10 combined current/history files, 5 MiB per image, 10 MiB combined raw image bytes, 128 KiB combined UTF-8 text. These are not claims about universal OpenRouter limits.
- Only bounded plain-text/Markdown files are supported alongside images. PDF, Office, archive, SVG, video and other unsupported inputs fail explicitly; there is no silent omission or new parser dependency.
- Strict validation also applies to selected historical attachments. An old unsupported, missing or oversized file can therefore require starting a fresh Chat or using Agent mode. No automatic deletion or credential fallback is performed.
- Provider failures must produce safe categories without preserving upstream error bodies or secrets. A rejected BYO key is never replaced with the house credential.

## Verification status

Independent review found abort-insensitive byte reads, ambiguous historical attribution, a failing worker-size ratchet, weak provider-payload/error tests, and unbounded 403 error-body buffering. All were addressed: single abort-aware integrity-checked reads, matching numbered history/attachment labels, worker extraction below 800 lines, valid PNG/exact-payload regressions, and reuse of the existing 64 KiB/100 ms response-prefix reader. Final code review APPROVE and architecture CLEAR; no new dependency or generic parser was added.

Thirty pure Chat/provider-retry/ratchet tests and the full-root pinned TypeScript 5.9 check pass after scoped cleanup removed redundant constructor assignments only. Targeted lint exits zero with warnings; diff check passes. Live key-error tracking is filed separately as issue #345, including connection-health behavior not implemented in this patch.

Local database tests are intentionally excluded because the preload can migrate a shared database. Database-backed upload/claim/history/provider integration must pass isolated CI. No live successful image understanding is claimed before this fix is deployed. The user changed their own credential; this audit did not change credentials, extension settings, production processes or existing user files.
