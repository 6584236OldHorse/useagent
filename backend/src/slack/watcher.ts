/**
 * Live progress feedback for a Slack-originated run, routed through the durable
 * Slack outbox as native stream chunks: one task card per tool call (updated in
 * place by id, coalesced on a short debounce), one plan_update per plan/todos
 * step, and exact-offset narration markdown - with the Block Kit card update
 * carried as fallback in the same outbox row. Runtime chatter (boot, provider
 * waits, context updates) never reaches the thread. DM threads additionally get
 * the free-text working shimmer (assistant thread status), cleared when the run
 * settles.
 *
 * This watcher is best-effort: it can miss live progress if the process dies.
 * Terminal delivery is stronger and happens in finalizeRun via durable
 * stop_stream plus plain-message fallback, so a boot-reconciled run still replies.
 */
import { getRun } from "../runs/repo";
import type { RunStatus } from "../db/schema";
import { bus, channel as runChannel, type BusEvent } from "../worker";
import { turnStream } from "../runs/turn-stream";
import { env } from "../env";
import { buildRunCard, deriveTitle, sessionUrl, type RunCardInput } from "./card";
import { parseRepoRef } from "../github/repo-ref";
import { enqueueAppendStream, enqueueSessionStatus, enqueueThreadStatus } from "./outbox";
import {
  createNarrationBuffer,
  directMessageChannel,
  markdownChunksFor,
  planUpdateFromStep,
  statusTextForStep,
  stepProgressChunks,
  toolTaskChunk,
  type SlackStreamChunk,
  type SlackTaskUpdateStreamChunk,
} from "./streaming";

/** Card revisions coalesce per stream on this debounce: a run revising a card
 *  twenty times in a second sends one append carrying the last revision
 *  (chat.appendStream is rate limited per workspace). */
export const CARD_FLUSH_MS = 250;
/** Narration flush cadence - coalesces deltas into bounded appends. */
const NARRATION_FLUSH_MS = 2_500;

export function watchSlackRun(opts: {
  runId: string;
  orgId: string;
  /** The Slack thread's ROOT run id - owns the card the updates target. Equals
   *  runId for a root run; a reply passes its thread root. */
  rootRunId: string;
  teamId: string;
  channel: string;
  threadTs: string;
}): void {
  const { runId, rootRunId, orgId, teamId, channel, threadTs } = opts;
  let settled = false;
  const dm = directMessageChannel(channel);

  /** The card chrome (title/model/repos/url) resolved once and reused for every
   *  fallback card this watcher enqueues. */
  let cardBase: Promise<Omit<RunCardInput, "phase" | "workingStep"> | null> | null = null;
  const loadCardBase = (): Promise<Omit<RunCardInput, "phase" | "workingStep"> | null> => {
    cardBase ??= getRun(rootRunId).then((run) =>
      run
        ? {
            title: deriveTitle(run.prompt),
            model: run.model,
            repoSpecs: run.repos.map(parseRepoRef),
            webUrl: sessionUrl(env.FRONTEND_ORIGIN, run.threadId),
          }
        : null,
    );
    return cardBase;
  };

  const enqueueChunks = (input: {
    idempotencyKey: string;
    chunks: readonly SlackStreamChunk[];
    workingStep?: string;
    narrationOffset?: number;
  }): void => {
    void (async () => {
      const base = await loadCardBase();
      if (!base) return;
      const card = buildRunCard({ ...base, phase: "running", workingStep: input.workingStep });
      await enqueueAppendStream({
        idempotencyKey: input.idempotencyKey,
        orgId,
        teamId,
        channel,
        threadTs,
        runId,
        chunks: input.chunks,
        narrationOffset: input.narrationOffset,
        fallbackBlocks: card.blocks,
        fallbackText: card.text,
      });
    })().catch(() => {});
  };

  // ── tool cards: the latest revision per card id, flushed on a debounce ──
  const pendingCards = new Map<string, SlackTaskUpdateStreamChunk>();
  let cardTimer: ReturnType<typeof setTimeout> | null = null;
  let cardSeq = 0;
  let openCard: SlackTaskUpdateStreamChunk | null = null;
  const flushCards = (): void => {
    if (cardTimer) clearTimeout(cardTimer);
    cardTimer = null;
    if (pendingCards.size === 0) return;
    const chunks = [...pendingCards.values()];
    pendingCards.clear();
    cardSeq += 1;
    enqueueChunks({
      idempotencyKey: `slack-stream:step:${teamId}:${runId}:${cardSeq}`,
      chunks,
      workingStep: openCard?.title,
    });
    if (dm && openCard) {
      void enqueueThreadStatus({
        idempotencyKey: `slack-thread-status:step:${teamId}:${runId}:${openCard.id}`,
        orgId,
        teamId,
        channel,
        threadTs,
        runId,
        status: statusTextForStep(openCard.title),
      }).catch(() => {});
    }
  };
  const queueCards = (chunks: readonly SlackTaskUpdateStreamChunk[]): void => {
    for (const chunk of chunks) pendingCards.set(chunk.id, chunk);
    if (!cardTimer) {
      cardTimer = setTimeout(flushCards, CARD_FLUSH_MS);
      cardTimer.unref?.();
    }
  };

  // ── narration: buffered deltas flushed as exact-offset markdown appends ──
  const narration = createNarrationBuffer();
  let narrationSeq = 0;
  const flushNarration = (): void => {
    const segment = narration.take();
    if (!segment) return;
    narrationSeq += 1;
    enqueueChunks({
      idempotencyKey: `slack-stream:text:${teamId}:${runId}:${narrationSeq}`,
      chunks: markdownChunksFor(segment.text),
      narrationOffset: segment.offset,
    });
  };
  const unsubscribe = turnStream.subscribe(runId, (delta, kind) => {
    if (kind !== undefined) return; // reasoning stays out of the message body
    narration.push(delta);
  });
  const narrationTimer = setInterval(flushNarration, NARRATION_FLUSH_MS);
  narrationTimer.unref?.();

  const finish = (): void => {
    if (settled) return;
    settled = true;
    bus.off(runChannel(runId), onEvent);
    unsubscribe();
    clearInterval(narrationTimer);
    flushCards();
    void enqueueSessionStatus({
      idempotencyKey: `slack-status:end:${teamId}:${runId}`,
      orgId,
      teamId,
      channel,
      threadTs,
      runId,
      status: "active",
    }).catch(() => {});
    if (dm) {
      void enqueueThreadStatus({
        idempotencyKey: `slack-thread-status:end:${teamId}:${runId}`,
        orgId,
        teamId,
        channel,
        threadTs,
        runId,
        status: "",
      }).catch(() => {});
    }
  };

  const onEvent = (ev: BusEvent): void => {
    if (ev.type === "end") {
      finish();
      return;
    }
    if (ev.type !== "step" || settled) return;
    // The done marker lands right before finalization: flush what is pending
    // so the last revisions reach the stream ahead of the stop.
    if (ev.step.kind === "done") {
      flushCards();
      return;
    }

    // A plan/todos step surfaces as ONE plan_update chunk (plans change rarely
    // and the chunk is idempotent per step).
    const plan = planUpdateFromStep({ label: ev.step.label, chip: ev.step.chip, codeJson: ev.step.code_json });
    if (plan) {
      enqueueChunks({
        idempotencyKey: `slack-stream:plan:${teamId}:${runId}:${ev.step.id}`,
        chunks: [plan],
        workingStep: ev.step.label,
      });
      return;
    }

    // A tool call is one card revised in place; everything else is chatter.
    const card = toolTaskChunk(ev.step);
    if (!card) return;
    const progress = stepProgressChunks(openCard, card);
    openCard = progress.open;
    queueCards(progress.chunks);
  };

  bus.on(runChannel(runId), onEvent);

  // Race guard: the run may already be terminal before we subscribed.
  void getRun(runId).then((r) => {
    if (r && isTerminal(r.status)) finish();
  });
}

const isTerminal = (s: RunStatus): boolean => s === "completed" || s === "failed";
