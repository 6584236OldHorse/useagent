# Native Codex checklist availability audit

## Reproduction

In the same retained QA Codex thread, both Luna and Sol were explicitly asked to call the available native checklist tool rather than write a prose plan. Both reported that no native plan/checklist tool was exposed. No native plan card was created.

`live-tool-unavailable.png` captures the Sol attempt. This is before-fix evidence, not a deployed-success screenshot.

## Source-backed cause

The product's `plans: true` capability describes its ability to project native plan events. It does not itself register a tool in Codex. The pinned Codex 0.153.3 tool registry defaults `tools.update_plan.enabled` to false and registers the native handler only when explicitly enabled. The inspected product launch paths did not set that override.

Pinned upstream evidence: [configuration resolver](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/core/src/config/mod.rs#L2648-L2654), [tool registration gate](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/core/src/tools/spec_plan.rs#L1131-L1138).

The model/tool owner differs by authentication path:

- Subscription: the trusted backend's per-run model-side app-server in `codex-subscription-relay.ts`.
- Gateway/local login: T3's local model-side app-server, configured through stable Codex launch arguments.
- The sandbox exec-server only supplies command execution; adding the flag there would not fix tool exposure.
- The account-discovery broker is not a run's model-side process and remains unchanged.

## Required reliability boundary

Retained T3 instances may already own an app-server launched with old arguments. A disk settings change alone does not prove that the running provider applied it. Independent review rejected the initial stdout-only change signal: preparation failure or a backend restart could lose the restart intent, and local login could discard the first bootstrap's change result.

The correction must keep pending configuration intent durable until a successful in-place restart/readiness acknowledgement, preserve native thread/cursor and workspace identity, and test failed preparation/restart/retry paths dynamically. Source-text ordering assertions are insufficient.

The acknowledgement is a read/compare/unlink sequence, not a multi-writer compare-and-swap. That is sufficient only under the product's required single-backend deployment and per-thread turn serialization. A lost acknowledgement or a prewarm that already applied the setting may cause one extra restart; neither may skip a required restart. Supporting concurrent backend writers would require a different coordination boundary.

## Scope and validation limits

No prompt is added to force checklist use on every task. The fix exposes the native capability; the model still chooses when to use it. Native plan event projection already exists and must remain unchanged.

No sandbox replacement/deletion, credential changes, account-broker change, PR merge or deployment is part of this audit. Before claiming live tool availability, run a post-deployment native checklist canary on a retained QA thread. Local tests prove the launch configuration and durable fence, not a deployed native Codex session.

Final independent code review: APPROVE, gated on relay CI. Architecture: WATCH with no remaining blocking defect, subject to the serialization, prewarm and native-canary limits above. The authoritative marker reader now accepts only explicit absence or the expected revision; missing output, malformed content and transport/read errors fail preparation instead of skipping the restart.

After the scoped cleanup removed an unused generated-script marker read, all 103 pure runtime/adapter/bridge/subscription/ratchet tests and the full-root pinned TypeScript 5.9 check pass. New-module lint is clean. Broader changed-file lint reports three errors on unchanged baseline lines (unsafe-finally throw, implicit-any probe and an iterable test callback); no unrelated cleanup was applied. Relay database tests remain an isolated-CI requirement.
