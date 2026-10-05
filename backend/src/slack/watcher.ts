/**
 * Live progress for one Slack turn, routed through the durable Slack outbox:
 * the thread card advanced in place (still spinning, its `output` the current
 * step verb; at most one revision per 3 s, the latest state winning), the
 * turn's answer streamed as its own message (opened on the first narration
 * segment, markdown only, appended at exact offsets), and the working shimmer
 * kept alive while nothing has streamed yet. Runtime chatter (boot, provider
 * waits, context updates) never reaches the thread.
 *
 * This watcher is best-effort: it can miss live progress if the process dies.
 * Terminal delivery is stronger and happens in finalizeRun via durable
 * stop_stream + card revision plus plain-message fallback, so a boot-reconciled
 * run still replies.
 */
import { getRun } from "../runs/repo";
import type { RunStatus } from "../db/schema";
import { bus, channel as runChannel, type BusEvent } from "../worker";
import { turnStream } from "../runs/turn-stream";
import { buildRunCard, type RunCardInput } from "./card";
import { toSlackMrkdwn } from "./mrkdwn";
import { slackThreadCardBase } from "./repo";
import { enqueueAppendStream, enqueueStartStream, enqueueThreadStatus, enqueueUpdateCard } from "./outbox";
import { createNarrationBuffer, markdownChunksFor, toolTaskChunk, WORKING_PHRASES } from "./streaming";

/** Card revisions land at most this often (Slack's chat.update guidance):
 *  a step revised twenty times in a second sends one update with the latest
 *  state. */
export const CARD_FLUSH_MS = 3_000;
/** Narration flush cadence - coalesces deltas into bounded appends. */
const NARRATION_FLUSH_MS = 2_500;
/** The free-text shimmer expires two minutes after it was set (Slack docs);
 *  re-sent on this cadence while the turn has streamed nothing yet. */
const SHIMMER_KEEPALIVE_MS = 90_000;

export function watchSlackRun(opts: {
  runId: string;
  orgId: string;
  /** The Slack thread's ROOT run id - owns the card the revisions target. Equals
   *  runId for a root run; a reply passes its thread root. */
  rootRunId: string;
  teamId: string;
  channel: string;
  threadTs: string;
  /** The Slack user who asked - chat.startStream requires the recipient
   *  identity when streaming into a channel. */
  slackUserId?: string;
}): void {
  const { runId, rootRunId, orgId, teamId, channel, threadTs, slackUserId } = opts;
  let settled = false;
  const reply = runId !== rootRunId;

  /** The card chrome (title/model/repos/url) resolved once per watcher. */
  let cardBase: Promise<Omit<RunCardInput, "status" | "output"> | null> | null = null;
  const loadCardBase = (): Promise<Omit<RunCardInput, "status" | "output"> | null> => {
    cardBase ??= getRun(runId).then((run) => (run ? slackThreadCardBase(run) : null));
    return cardBase;
  };

  // ── thread card: the current verb, flushed at most every CARD_FLUSH_MS ──
  let output: string | null = null;
  let sentOutput: string | null | undefined;
  let cardTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFlushAt = 0;
  let cardSeq = 0;
  const flushCard = (): void => {
    cardTimer = null;
    if (settled || output === sentOutput) return;
    sentOutput = output;
    lastFlushAt = Date.now();
    cardSeq += 1;
    const seq = cardSeq;
    const verb = output;
    void loadCardBase()
      .then((base) => {
        if (!base) return;
        const card = buildRunCard({ ...base, status: "in_progress", output: verb });
        return enqueueUpdateCard({
          idempotencyKey: `slack-card:step:${teamId}:${runId}:${seq}`,
          orgId,
          teamId,
          channel,
          threadTs,
          rootRunId,
          runId,
          blocks: card.blocks,
          text: card.text,
        });
      })
      .catch(() => {});
  };
  const noteCard = (verb: string | null): void => {
    output = verb;
    if (cardTimer) return;
    cardTimer = setTimeout(flushCard, Math.max(0, lastFlushAt + CARD_FLUSH_MS - Date.now()));
    cardTimer.unref?.();
  };

  // ── the answer: narration streamed as this turn's own message ──
  const narration = createNarrationBuffer();
  let streamStarted = false;
  let narrationSeq = 0;
  const flushNarration = (): void => {
    const segment = narration.take();
    if (!segment) return;
    const chunks = markdownChunksFor(segment.text);
    if (!streamStarted) {
      // The stream opens on the first real text: a markdown chunk, never a
      // placeholder row. The plain-message fallback carries the same text.
      streamStarted = true;
      void enqueueStartStream({
        idempotencyKey: `slack-stream:start:${teamId}:${runId}`,
        orgId,
        teamId,
        channel,
        threadTs,
        runId,
        taskDisplayMode: "timeline",
        chunks,
        recipientTeamId: teamId,
        recipientUserId: slackUserId,
        fallbackText: toSlackMrkdwn(segment.text),
      }).catch(() => {});
      return;
    }
    narrationSeq += 1;
    void enqueueAppendStream({
      idempotencyKey: `slack-stream:text:${teamId}:${runId}:${narrationSeq}`,
      orgId,
      teamId,
      channel,
      threadTs,
      runId,
      chunks,
      narrationOffset: segment.offset,
      fallbackText: toSlackMrkdwn(turnStream.snapshot(runId) ?? segment.text),
    }).catch(() => {});
  };
  const unsubscribe = turnStream.subscribe(runId, (delta, kind) => {
    if (kind !== undefined) return; // reasoning stays out of the message body
    narration.push(delta);
  });
  const narrationTimer = setInterval(flushNarration, NARRATION_FLUSH_MS);
  narrationTimer.unref?.();

  // ── the shimmer: kept alive until the answer starts streaming ──
  let keepalive = 0;
  const shimmerTimer = setInterval(() => {
    if (streamStarted) return;
    keepalive += 1;
    void enqueueThreadStatus({
      idempotencyKey: `slack-thread-status:keep:${teamId}:${runId}:${keepalive}`,
      orgId,
      teamId,
      channel,
      threadTs,
      runId,
      status: WORKING_PHRASES[0],
      loadingMessages: WORKING_PHRASES,
    }).catch(() => {});
  }, SHIMMER_KEEPALIVE_MS);
  shimmerTimer.unref?.();

  const finish = (): void => {
    if (settled) return;
    settled = true;
    bus.off(runChannel(runId), onEvent);
    unsubscribe();
    clearInterval(narrationTimer);
    clearInterval(shimmerTimer);
    if (cardTimer) clearTimeout(cardTimer);
    // Finalization settles the card, clears the shimmer and closes the stream
    // durably; a live revision landing after that would be dropped anyway.
  };

  let seenStep = false;
  const onEvent = (ev: BusEvent): void => {
    if (ev.type === "end") {
      finish();
      return;
    }
    if (ev.type !== "step" || settled) return;
    // A follow-up turn that waited its turn in the thread: the card spins
    // again the moment the run actually starts (the root's card was posted
    // spinning at accept).
    if (!seenStep) {
      seenStep = true;
      if (reply) noteCard(null);
    }
    // A tool call names the card's current verb; everything else is chatter.
    const verb = toolTaskChunk(ev.step)?.title;
    if (verb) noteCard(verb);
  };

  bus.on(runChannel(runId), onEvent);

  // Race guard: the run may already be terminal before we subscribed.
  void getRun(runId).then((r) => {
    if (r && isTerminal(r.status)) finish();
  });
}

const isTerminal = (s: RunStatus): boolean => s === "completed" || s === "failed";
