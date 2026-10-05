# Root assistant narration lost on reload

Live QA run: `27c571a3-22ad-4bcf-8629-498ef3d39fbc`, Codex Manual mode, synthetic standalone workspace.

1. Ask for one native command creating a synthetic marker file.
2. Observe the assistant's explanation before the pending approval card.
3. Reload before approving. The command and same pending approval survive, but the explanation disappears.
4. Decline. The final denial is saved, but the earlier explanation remains missing.

![Before reload](before-reload.png)
![After reload](after-reload.png)

A read-only query scoped to this QA run found no root assistant text events in provider_events or canonical_events and no match for the visible phrase. Only the final denial exists in the run summary. The trusted runtime projector persisted activities but published assistant messages only through the volatile delta stream; reconciliation likewise restored only activities.

The regression requires native and canonical replay with empty liveText to preserve all owned assistant messages, authoritative revisions and long Unicode text. Completed rendering must replace only the actual final answer with the run summary, not discard earlier adjacent commentary. Capture must redact before durable writes and preserve transactional settlement fencing.

Validation is recorded in the PR. Database-backed atomic rollback/fence tests require isolated CI; do not run the backend preload against a shared development database. These screenshots are pre-fix reproduction evidence, not a claim that production has been updated.

The pinned runtime snapshot orders messages by created_at and message_id; this supports the historical null-turn-ID association between accepted user messages and their following assistant messages. The snapshot exposes messages and activities as separate arrays without a common global sequence. Reconciliation preserves message identity, message order and content, but cannot reconstruct exact message/tool interleaving that the provider snapshot does not represent. Already-settled historical runs without captured narration are not backfilled by this change.
