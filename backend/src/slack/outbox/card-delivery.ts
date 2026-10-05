/**
 * Thread card delivery for the Slack outbox: the one Block Kit card a rooted
 * Slack thread carries, posted once (post_card) and advanced in place
 * (update_card) as its turns run. Revisions are ordered thread-wide and paced
 * to Slack's chat.update guidance; the card ts and revision ledger live on
 * slack_threads. Split out of delivery.ts, which owns claiming, classifying and
 * state transitions.
 */
import type { DeliveryResult, SlackClient } from "../client";
import { getSlackCardTsByRoot, setSlackCardTs } from "../repo";
import type { ClaimedRow } from "./repo";

/** Post the thread card once per thread (a heal or a later turn re-enqueues
 *  under the same key; a thread that already has its card keeps it). */
export async function deliverPostCard(client: SlackClient, p: Record<string, unknown>): Promise<DeliveryResult> {
  const string = (key: string): string | undefined =>
    typeof p[key] === "string" && p[key] ? (p[key] as string) : undefined;
  const teamId = string("teamId");
  const channel = string("channel");
  const threadTs = string("threadTs");
  const rootRunId = string("rootRunId") ?? string("runId");
  const text = string("text");
  const blocks = Array.isArray(p.blocks) ? p.blocks : undefined;
  if (!teamId || !channel || !threadTs || !rootRunId || !text) {
    return { ok: false, class: "permanent", message: "invalid_payload" };
  }
  // One card per thread: a heal or a later turn re-enqueues under the same
  // key, and a thread that already has its card keeps it.
  if ((await getSlackCardTsByRoot(rootRunId))?.cardTs) return { ok: true };
  const res = await client.postMessage({ channel, text, threadTs, blocks });
  // Persist the card ts so later revisions target the SAME message. A crash
  // between the post and this write redelivers the row (at-least-once): a
  // re-post is a benign duplicate card, and the next revision heals the ts.
  if (res.ok && res.ts) await setSlackCardTs(rootRunId, res.ts);
  return res;
}

/** Advance the thread card in place, honouring the thread-wide revision order,
 *  and post it fresh when the thread has none or the card is gone. */
export async function deliverUpdateCard(client: SlackClient, p: Record<string, unknown>): Promise<DeliveryResult> {
  const string = (key: string): string | undefined =>
    typeof p[key] === "string" && p[key] ? (p[key] as string) : undefined;
  const teamId = string("teamId");
  const channel = string("channel");
  const threadTs = string("threadTs");
  const rootRunId = string("rootRunId") ?? string("runId");
  const text = string("text");
  const blocks = Array.isArray(p.blocks) ? p.blocks : undefined;
  if (!teamId || !channel || !threadTs || !rootRunId || !text) {
    return { ok: false, class: "permanent", message: "invalid_payload" };
  }
  const runId = string("runId") ?? rootRunId;
  const revision = typeof p.revision === "number" ? p.revision : null;
  const card = await getSlackCardTsByRoot(rootRunId);
  // Revisions are ordered thread-wide: one older than the card's (a
  // retried row, a delayed terminal revision of a turn a newer turn has
  // since moved past) is done without touching Slack. A turn's own
  // terminal revision is the exception: it settles whatever live
  // revision of that turn landed after it was enqueued.
  if (card && revision !== null && revision <= card.cardRevision) {
    const ownTurn = p.live !== true && card.cardRevisionRunId === runId;
    if (!ownTurn) return { ok: true };
  }
  const applied = revision === null ? undefined : { revision, runId };
  // Advance the thread card in place; a transient/rate-limited failure
  // retries the whole row.
  if (card?.cardTs) {
    const res = await client.updateMessage({ channel, ts: card.cardTs, text, blocks });
    if (res.ok) await setSlackCardTs(rootRunId, card.cardTs, applied);
    if (res.ok || res.class !== "permanent") return res;
  }
  // No card yet (the post never landed) or the card is gone: post it fresh
  // so the thread always has its one card, and remember the new ts.
  const posted = await client.postMessage({ channel, text, threadTs, blocks });
  if (posted.ok && posted.ts) await setSlackCardTs(rootRunId, posted.ts, applied);
  return posted;
}

/** Card revisions are paced to Slack's chat.update guidance (one every few
 *  seconds): how long a revision must still wait after the card's last update.
 *  Zero for a thread without a card yet or for a revision already superseded. */
export async function cardPaceWaitMs(row: ClaimedRow): Promise<number> {
  let payload: { rootRunId?: unknown; runId?: unknown; revision?: unknown };
  try {
    payload = JSON.parse(row.payload) as typeof payload;
  } catch {
    return 0;
  }
  const rootRunId = typeof payload.rootRunId === "string" ? payload.rootRunId : typeof payload.runId === "string" ? payload.runId : null;
  if (!rootRunId) return 0;
  const card = await getSlackCardTsByRoot(rootRunId);
  if (!card?.cardUpdatedAt) return 0;
  if (typeof payload.revision === "number" && payload.revision <= card.cardRevision) return 0;
  const paceMs = Number(process.env.SLACK_CARD_PACE_MS ?? 3000);
  return Math.max(0, paceMs - (Date.now() - card.cardUpdatedAt.getTime()));
}
