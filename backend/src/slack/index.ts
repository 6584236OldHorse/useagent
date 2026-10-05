/**
 * Slack adapter (v1) — env-gated Events-API ingest that maps Slack threads onto
 * runs. Single mount point for src/index.ts; `slackEnabled()` (from ../env)
 * decides whether it wires up at all.
 *
 * Slack app manifest requirements: scopes `app_mentions:read`, `im:history`,
 * `channels:history` + `groups:history` (thread follow), `chat:write`,
 * `reactions:write`, and `assistant:write` for the AI-Apps status shimmer
 * (`assistant.threads.setStatus`); the app must enable the **Agents & AI Apps**
 * feature for the shimmer to render (elsewhere setStatus errors and we silently
 * fall back to 👀-ack + completion post). Event subscriptions: `app_mention`,
 * `message.im` (+ `message.channels`/`message.groups` for thread follow),
 * request URL → POST /api/slack/events. `assistant_thread_started` is NOT
 * required for v1 — it only signals the assistant pane opening (for a greeting /
 * suggested prompts); the user's actual message still arrives as `message.im`
 * and is handled by the DM path, so runs are created without it.
 */
import { slackConfig } from "../env";
import { outboxEntryExists, slackSpendRefusalKey, startSlackOutboxRelay } from "./outbox";
import { startSlackSocketMode } from "./socket-mode";
import { handleSlackEvent, slackEventIsEarlyNoop } from "./events";
import {
  type SlackInboxClaim,
  type SlackInboxOutcome,
  startSlackInboxPump,
  verifySlackInboxIdentity,
} from "./inbox";
import {
  recordSlackTurnIdentityIntent,
  recoverSlackTurnIdentities,
  stampSlackTurnIdentity,
} from "./turn-identity";

export { slackRoutes } from "./routes";
export { slackEnabled } from "../env";
export { setSlackClientForTest, type SlackClient } from "./client";
export { stopSlackSocketMode } from "./socket-mode";
export { syncSlackWorkspaceBindings } from "./workspaces";

/** Process one durably accepted inbox claim: verify the ingress-time identity,
 *  settle a message the ledger already refused, hand the event to the run
 *  mapper, record durably what the identity stamp of an accepted (or replayed)
 *  run still owes, then start that stamp so the web can show the sender and
 *  link back. The intent is its own row that no terminal write locks, so the
 *  claim never waits on the run row; the stamp is not awaited, because the
 *  inbox processes events serially and a Slack lookup must never hold the next
 *  event; the recorded intent survives a crash and the boot sweep finishes it.
 *  Exported so tests replay claims through it, never through a copy. */
export async function handleSlackInboxClaim({
  payload,
  checkpointStagedAttachmentIds,
}: SlackInboxClaim): Promise<SlackInboxOutcome> {
  if (slackEventIsEarlyNoop(payload.envelope)) return { status: "completed" };
  const identity = await verifySlackInboxIdentity(payload);
  if (identity.status === "ignored") return { status: "completed" };
  if (identity.status === "rebound") {
    return { status: "permanent", error: identity.error };
  }
  // A message refused for spend was durably answered under its own key. A
  // claim reclaimed from a crash between that answer and the inbox marker
  // settles the same way and is never re-admitted, even once the allowance
  // has been raised.
  const { team_id: teamId, event } = payload.envelope;
  if (teamId && event?.channel && event.ts && await outboxEntryExists(slackSpendRefusalKey(teamId, event.channel, event.ts))) {
    return { status: "completed", noop: "spend_allowance_exceeded" };
  }
  const outcome = await handleSlackEvent(payload.envelope, {
    identity,
    stagedAttachmentIds: payload.stagedAttachmentIds,
    checkpointStagedAttachmentIds,
  });
  if (outcome.status === "accepted" || outcome.status === "replayed") {
    const { teamId, channel, messageTs, slackUserId } = payload.identity;
    if (teamId && channel && messageTs) {
      await recordSlackTurnIdentityIntent({
        runId: outcome.runId,
        teamId,
        channel,
        messageTs,
        slackUserId,
        channelType: event?.channel_type ?? null,
      });
      void stampSlackTurnIdentity(outcome.runId);
    }
    return { status: "completed" };
  }
  // A no-op is not an acceptance: it settles marked, so a duplicate delivery
  // can never reopen it into new work (a refused message stays refused even
  // once the allowance is raised).
  if (outcome.status === "permanent_noop") return { status: "completed", noop: outcome.reason };
  if (outcome.status === "waiting_for_root") return { status: "waiting_for_root" };
  return { status: "retryable_unavailable", error: outcome.reason };
}

/** Start the durable outbox delivery relay (boot recovery + interval) and,
 *  when SLACK_APP_TOKEN is set, the Socket Mode ingress (WebSocket lane - no
 *  public URL required; both transports persist into the same inbox). Called
 *  from src/index.ts only when Slack is configured. No-op if unconfigured. */
export function startSlackOutbox(): void {
  const cfg = slackConfig();
  if (!cfg) return;
  startSlackOutboxRelay(cfg);
  void recoverSlackTurnIdentities();
  startSlackInboxPump(handleSlackInboxClaim);
  startSlackSocketMode();
}
