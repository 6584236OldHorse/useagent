import { and, desc, eq, inArray, ne, or } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { artifacts, providerEvents, runs, threadRelationships, type RunStatus } from "../db/schema";
import { completeRun } from "./repo";
import { resolveScopedMemory } from "../memory/scope";
import { enqueueCapture } from "../memory/capture-outbox";
import { collectRunEvidence } from "../memory/capture-evidence";
import { assessCaptureSalience } from "../memory/capture-salience";
import { isInternalRunOrigin } from "./origin";
import { recordRunFollowups } from "./followups";
import {
  createSlackRunResponse,
  findSlackRunResponse,
  findSlackThreadForProductThread,
  slackThreadCardBase,
} from "../slack/repo";
import { toSlackMrkdwn } from "../slack/mrkdwn";
import { buildRunCard, cardStatusFor } from "../slack/card";
import {
  composeAutomationDeliveryText,
  resolveSlackAutomationTargetForOrg,
} from "../slack/automation";
import {
  enqueuePostMessageTx,
  enqueueStopStreamTx,
  enqueueThreadStatusTx,
  enqueueUpdateCardTx,
  enqueueUploadFileTx,
  kickSlackOutbox,
  SLACK_OUTBOX_PAYLOAD_CAP,
  slackArtifactDeliveryIdempotencyKey,
} from "../slack/outbox";
import { chunkSlackText } from "../slack/chunk";
import { codePointCut, composeStreamClosing, STREAM_NARRATION_CAP } from "../slack/streaming";
import { turnStream } from "./turn-stream";
import { findScheduleForRun, settleFiring } from "../schedules/repo";
import { publishRunLifecycleChange } from "./org-signals";
import { enqueueCanonicalization } from "./canonicalization-outbox";
import { canonicalEngine } from "../engines/engine-alias";
import { enqueueLearning } from "../learning/learning-outbox";
import { releaseLeaseForRun } from "../fleet/lease-repo";
import { accrueRunSandboxMinutes } from "./sandbox-minutes";
import { executionGraphEnabled } from "./execution-graph-switch";
import {
  prepareExecutionGraphSeal,
  sealExecutionGraphAfterFinalizeTx,
} from "./execution-graph-seal";
import { evaluateFinishedWork, finishedWorkFailureSummary } from "./finished-work";
import { listFinishedWorkForRun } from "./finished-work-repo";
import { finishedWorkEnforcementEnabled, finishedWorkRolloutMode } from "./finished-work-rollout";
import { lockFinishedWorkRun } from "./finished-work-lock";
import { completeRunOutputs } from "../artifacts/completion";
import { CANCEL_SUMMARY, hasRunCancelIntent } from "../commands/cancel";
import { COMPACT_STOPPED_WAITING_SUMMARY } from "../engines/runtime-compact-contract";
import { enqueueSlackUserMirrorForRun } from "../slack/user-mirror";
import { drainProviderEvents } from "./provider-events";
import { accrueRunSpend } from "./spend";
import { withTransientDbRetry } from "../db/transient-retry";

/** Providers whose runs project native events and/or `steps` into the canonical lane.
 *  Native engines plus historical ACP rows, which can still finish canonicalization
 *  without registering a new ACP execution lane. Legacy aliases (daytona -> opencode,
 *  claude-sdk -> claude) run the same adapter, so they normalize into this set via
 *  {@link canonicalEngine} and are NOT left silently outside the lane. Only `mock`
 *  (scripted) has no provider source to translate. */
const CANONICAL_ENGINES = new Set(["opencode", "acp", "claude", "codex", "pi"]);

export function terminalCanonicalizationEligible(engine: string): boolean {
  return CANONICAL_ENGINES.has(canonicalEngine(engine));
}

type RunRow = typeof runs.$inferSelect;

/** TEST ONLY: a barrier finalizers cross before taking the family lock, so a
 *  test can hold two sibling finalizers at the contested point (their own
 *  terminal writes uncommitted) and prove the lock serializes them. */
let familyLivenessBarrier: ((runId: string) => Promise<void>) | null = null;
export function setFamilyLivenessBarrierForTest(barrier: ((runId: string) => Promise<void>) | null): void {
  familyLivenessBarrier = barrier;
}

/** Serialized room a reply row may use for the answer text it stores: the
 *  outbox cap less the row's other fields (ids, keys, and a notification
 *  preview of at most a thousand units, six bytes each when escaped). */
const REPLY_ROW_BUDGET = SLACK_OUTBOX_PAYLOAD_CAP - 8_000;
const TAIL_ROW_BUDGET = SLACK_OUTBOX_PAYLOAD_CAP - 2_000;

/** The longest prefix of `text` (at most `maxUnits` UTF-16 units) whose
 *  STORED form, as `measure` sizes it, fits `budget`: rows are sized by what
 *  they persist (JSON-escaped, chunked), never by source length, so nothing is
 *  ever shed. The cut lands on a code point, preferring a line or a space. */
function fitPrefix(text: string, maxUnits: number, budget: number, measure: (prefix: string) => number): number {
  let lo = 0;
  let hi = Math.min(text.length, maxUnits);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  while (lo > 0 && measure(text.slice(0, lo)) > budget) lo = Math.floor(lo * 0.9);
  return cutAt(text, lo);
}

/** A cut at or before `at`: never inside a surrogate pair, and moved back to
 *  the last line break (else the last space) close behind it when one is near,
 *  so a split reads cleanly on both sides. */
function cutAt(text: string, at: number): number {
  if (at >= text.length) return text.length;
  const end = codePointCut(text, at);
  const back = text.slice(Math.max(0, end - 512), end);
  const line = back.lastIndexOf("\n");
  if (line >= 0) return end - back.length + line + 1;
  const near = back.slice(-128);
  const space = near.lastIndexOf(" ");
  if (space >= 0) return end - near.length + space + 1;
  return end;
}

/** Whether any run of the Slack thread's family other than `runId` is still
 *  queued or running: the family root's own turns and every product child
 *  thread under it. Read inside the finalize transaction, where this run is
 *  already terminal, and serialized on the family root's row: two sibling
 *  finalizers otherwise each see the other's uncommitted terminal state as
 *  still running and both leave the card spinning with nobody left to
 *  settle it. The second waits here until the first has committed. */
async function familyHasLiveRuns(tx: Executor, orgId: string, familyThreadId: string, runId: string): Promise<boolean> {
  await familyLivenessBarrier?.(runId);
  await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, familyThreadId)).for("update");
  const children = await tx
    .select({ threadId: threadRelationships.threadId })
    .from(threadRelationships)
    .where(and(eq(threadRelationships.orgId, orgId), eq(threadRelationships.familyThreadId, familyThreadId)));
  const threadIds = [...new Set([familyThreadId, ...children.map((c) => c.threadId)])];
  const [live] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(and(
      eq(runs.orgId, orgId),
      inArray(runs.threadId, threadIds),
      inArray(runs.status, ["queued", "running"]),
      ne(runs.id, runId),
    ))
    .limit(1);
  return live !== undefined;
}

export async function enqueueSlackTerminalDeliveryForRunTx(
  tx: Executor,
  run: RunRow,
  status: RunStatus,
  summary: string,
  deliveryArtifactIds: readonly string[] = [],
): Promise<boolean> {
  const userMirror = await enqueueSlackUserMirrorForRun(run.id, tx);
  let kickSlack = userMirror.status === "ready" && userMirror.created;
  const thread = run.orgId
    ? await findSlackThreadForProductThread(run.orgId, run.threadId, tx)
    : null;
  let slack = await findSlackRunResponse(run.id, tx);
  if (
    slack &&
    (!thread || slack.teamId !== thread.teamId || slack.channel !== thread.channel || slack.threadTs !== thread.threadTs)
  ) {
    slack = null;
  }
  if (!slack && thread) {
    await createSlackRunResponse({ runId: run.id, ...thread }, tx);
    slack = await findSlackRunResponse(run.id, tx);
  }
  if (
    slack &&
    (!thread || slack.teamId !== thread.teamId || slack.channel !== thread.channel || slack.threadTs !== thread.threadTs)
  ) {
    slack = null;
  }
  if (!slack) return false;
  if (!run.orgId) return false;

  // The thread card settles with this turn's outcome, rendered from the ROOT
  // of the Slack thread (a child thread finishing never replaces the parent
  // card's identity); the answer itself is the turn's own message and never
  // repeats inside the card.
  const cardRoot = thread?.rootRunId ?? run.threadId;
  const base = await slackThreadCardBase(cardRoot, run.orgId, tx);

  // The COMPLETE reply as markdown: the narration the live watcher streamed
  // into the message body (process-local buffer; empty after a restart) plus
  // whatever of the reply that body lacks. The streamed message holds the
  // head of it; everything past that follows as plain messages of its own,
  // each waiting for the one before it, so no answer is ever cut or reordered.
  const narration = turnStream.snapshot(run.id) ?? "";
  const closing = composeStreamClosing({
    status: status === "failed" ? "failed" : "completed",
    summary,
    narration,
  });
  const body = narration + closing;
  // The head is sized by what the row STORES (the markdown, JSON-escaped):
  // an escape-heavy answer must fit without a chunk being shed. Narration
  // and closing travel apart: delivery drops from the narration only what
  // the stream already accepted, so a closing recovered after a restart (the
  // buffer empty, the stream's offset persisted) is never mistaken for
  // streamed text; the closing joins the row only once the narration is
  // whole, so the two never change order.
  const stored = (prefix: string): number => JSON.stringify(prefix).length;
  const narrationHead = fitPrefix(narration, STREAM_NARRATION_CAP, REPLY_ROW_BUDGET, stored);
  const closingHead = narrationHead === narration.length
    ? fitPrefix(closing, STREAM_NARRATION_CAP - narrationHead, REPLY_ROW_BUDGET - stored(narration), stored)
    : 0;
  // The stream's ACCEPTED boundary outranks the row's: what Slack already
  // holds is never repeated by a tail. When escaping keeps the row shorter
  // than the stream, the stop appends nothing of the narration and the tails
  // start where the stream ends (the plain fallback then shows the row's
  // head; the streamed message keeps what it accepted). The offset is read
  // here, at finalization; an append still in flight at this moment lands
  // after it and can be repeated by the first tail (a recorded residual).
  const accepted = codePointCut(narration, Math.min(slack.streamedChars, narration.length));
  const tailStart = (narrationHead < narration.length ? Math.max(narrationHead, accepted) : narrationHead) + closingHead;
  const replyKey = `slack-reply:${slack.teamId}:${run.id}`;

  kickSlack = (await enqueueStopStreamTx(tx, {
    idempotencyKey: replyKey,
    orgId: run.orgId,
    teamId: slack.teamId,
    channel: slack.channel,
    threadTs: slack.threadTs,
    runId: run.id,
    chunks: [],
    narrationText: narration.slice(0, narrationHead),
    closingMarkdown: closing.slice(0, closingHead),
    ...(userMirror.status === "ready"
      ? { waitForIdempotencyKey: userMirror.idempotencyKey }
      : {}),
  })) || kickSlack;
  let tailAfter = replyKey;
  for (let part = 0, at = tailStart; at < body.length; part += 1) {
    const rest = body.slice(at);
    // A tail row stores plain chunks: sized by their serialized form too.
    const length = fitPrefix(rest, STREAM_NARRATION_CAP, TAIL_ROW_BUDGET, (prefix) =>
      JSON.stringify(chunkSlackText(toSlackMrkdwn(prefix))).length) || Math.min(rest.length, 2);
    const tailKey = `slack-reply-tail:${slack.teamId}:${run.id}:${part}`;
    const tailCreated = await enqueuePostMessageTx(tx, {
      idempotencyKey: tailKey,
      orgId: run.orgId,
      teamId: slack.teamId,
      channel: slack.channel,
      threadTs: slack.threadTs,
      runId: run.id,
      text: toSlackMrkdwn(rest.slice(0, length)),
      messageRole: "reply_tail",
      part,
      waitForIdempotencyKey: tailAfter,
    });
    tailAfter = tailKey;
    at += length;
    kickSlack = kickSlack || tailCreated;
  }
  if (base) {
    // The shared card settles only when the whole family is done: a child
    // thread or a queued reply still to run keeps it spinning, cleared of
    // this turn's verb.
    const familyLive = await familyHasLiveRuns(tx, run.orgId, cardRoot, run.id);
    const card = buildRunCard({ ...base, status: familyLive ? "in_progress" : cardStatusFor(status) });
    const cardSettled = await enqueueUpdateCardTx(tx, {
      idempotencyKey: `slack-card:final:${slack.teamId}:${run.id}`,
      orgId: run.orgId,
      teamId: slack.teamId,
      channel: slack.channel,
      threadTs: slack.threadTs,
      rootRunId: cardRoot,
      runId: run.id,
      blocks: card.blocks,
      text: card.text,
    });
    kickSlack = kickSlack || cardSettled;
  }
  // Clear the free-text working shimmer durably (the in-process watcher also
  // clears it, but only this survives a restart).
  const shimmerCleared = await enqueueThreadStatusTx(tx, {
    idempotencyKey: `slack-thread-status:final:${slack.teamId}:${run.id}`,
    orgId: run.orgId,
    teamId: slack.teamId,
    channel: slack.channel,
    threadTs: slack.threadTs,
    runId: run.id,
    status: "",
  });
  kickSlack = kickSlack || shimmerCleared;

  if (status === "completed" || deliveryArtifactIds.length > 0) {
    const revisedEvents = await tx
      .select({ payload: providerEvents.payload })
      .from(providerEvents)
      .where(and(eq(providerEvents.runId, run.id), eq(providerEvents.eventType, "artifact.revised")));
    const revisedArtifactIds = revisedEvents.flatMap(({ payload }) => {
      let parsed: unknown;
      try {
        parsed = payload ? JSON.parse(payload) : null;
      } catch {
        parsed = null;
      }
      const id =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).id
          : null;
      return typeof id === "string" ? [id] : [];
    });
    const selectedIds = [...new Set([...revisedArtifactIds, ...deliveryArtifactIds])];
    const artifactScope =
      selectedIds.length > 0
        ? or(eq(artifacts.runId, run.id), inArray(artifacts.id, selectedIds))
        : eq(artifacts.runId, run.id);
    const runArtifacts = await tx
      .select({
        id: artifacts.id,
        runId: artifacts.runId,
        threadId: artifacts.threadId,
        name: artifacts.name,
        contentType: artifacts.contentType,
        sizeBytes: artifacts.sizeBytes,
        sha256: artifacts.sha256,
        storageKey: artifacts.storageKey,
        sourcePath: artifacts.sourcePath,
        workpieceRevision: artifacts.workpieceRevision,
      })
      .from(artifacts)
      .where(and(eq(artifacts.orgId, run.orgId), eq(artifacts.threadId, run.threadId), artifactScope))
      .orderBy(desc(artifacts.workpieceRevision), desc(artifacts.createdAt));
    for (const artifact of runArtifacts) {
      // Extracted slide pictures belong to their parent deck, not a separate
      // unsolicited Slack upload. Explicitly selected pictures still deliver.
      if (/::media\/[1-9]\d*$/.test(artifact.sourcePath) && !selectedIds.includes(artifact.id)) continue;
      // Publication already enforces the artifact byte limit. Never silently
      // drop the sixth file or a valid larger file at the delivery boundary.
      const created = await enqueueUploadFileTx(tx, {
        idempotencyKey: slackArtifactDeliveryIdempotencyKey({
          teamId: slack.teamId,
          runId: run.id,
          artifactId: artifact.id,
          artifactRevision: artifact.workpieceRevision,
          artifactSha256: artifact.sha256,
          channel: slack.channel,
          threadTs: slack.threadTs,
        }),
        orgId: run.orgId,
        teamId: slack.teamId,
        channel: slack.channel,
        threadTs: slack.threadTs,
        filename: artifact.name,
        title: artifact.name,
        artifactId: artifact.id,
        artifactRunId: artifact.runId,
        artifactThreadId: artifact.threadId,
        deliveryRunId: run.id,
        artifactSha256: artifact.sha256,
        artifactRevision: artifact.workpieceRevision,
        artifactStorageKey: artifact.storageKey,
        artifactContentType: artifact.contentType,
        size: artifact.sizeBytes,
      });
      kickSlack = kickSlack || created;
    }
  }

  return kickSlack;
}

// ---------------------------------------------------------------------------
// Run finalization — the ONE place a run reaches a terminal state, so the
// terminal-status commit and every DURABLE side-effect it triggers happen in a
// SINGLE transaction (north star "Transaction Boundaries").
//
// GAP 2 (memory capture): the capture used to be enqueued AFTER completeRun — a
// crash in that gap left a `completed` run with no capture, and the boot-reconcile
// + mock paths never enqueued at all. Folding it into the completion transaction
// makes "completed ⇒ capture enqueued" hold for EVERY completed run.
//
// GAP 3 (slack reply): the final Slack reply used to be enqueued by an in-process
// watcher that did NOT survive a restart (a boot-reconciled Slack run never
// replied) and fired AFTER completeRun (a crash in that gap lost the reply). It
// now enqueues here, in the finalization transaction, for BOTH terminal statuses,
// so a Slack-originated run's reply is durable and survives a crash/restart.
// Idempotent by `slack-reply:<runId>`, so re-finalizing never double-posts.
//
// A failure to enqueue rolls the whole transaction back (the run stays
// non-terminal and is retried), so a run is never marked terminal without its
// side-effects committed alongside.
// ---------------------------------------------------------------------------

/**
 * Commit a run's terminal status + summary and, in the SAME transaction, enqueue
 * its durable side-effects: the memory capture (completed runs, when team memory
 * is configured), the Slack reply (Slack-originated runs, both terminal
 * statuses), canonicalization, and the LEARNING intent (completed non-internal
 * runs - self_improving 6.1). Replaces the bare terminal-status update on every
 * terminal path (worker success/failure/mock, boot reconcile/fail). Safe to call
 * more than once - the run update is a plain UPDATE and every enqueue is idempotent.
 */
export type FinalizeRunResult =
  | { readonly applied: false }
  | { readonly applied: true; readonly status: "completed" | "failed"; readonly summary: string };

export async function resolveDurableFinalizationOutcome(
  runId: string,
  result: FinalizeRunResult,
): Promise<{ readonly status: "completed" | "failed"; readonly summary: string } | null> {
  if (result.applied) return { status: result.status, summary: result.summary };
  const [winner] = await db
    .select({ status: runs.status, summary: runs.summary })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  if (!winner || (winner.status !== "completed" && winner.status !== "failed")) return null;
  return { status: winner.status, summary: winner.summary ?? "" };
}

export interface FinalizeRunOptions {
  readonly signal?: AbortSignal;
  /** Non-mutating fence used before reads and inside each artifact commit. */
  readonly publicationClaim?: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<boolean>;
  /** Ownership guard evaluated INSIDE the finalization transaction, after the run row is
   *  read and before anything is written. When it returns false the transaction writes
   *  nothing and the result is `applied: false`. The reconciler passes its fenced
   *  parked-row delete here, so a tick that lost its claim cannot commit a terminal
   *  status over its replacement's work, and a crash can never leave a settled run
   *  with a parked row. */
  readonly claim?: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<boolean>;
}

export async function finalizeRun(
  runId: string,
  status: RunStatus,
  summary: string,
  durationMs: number,
  options: FinalizeRunOptions = {},
): Promise<FinalizeRunResult> {
  if (status !== "completed") return commitRunFinalization(runId, status, summary, durationMs, options);
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) return { applied: false };
  if (run.status !== "queued" && run.status !== "running") {
    // Recovery still has to consume its owned parked row and account for the
    // durable winner, even though no publication or status write may run again.
    return commitRunFinalization(runId, status, summary, durationMs, options);
  }
  const outputs = await completeRunOutputs(run, summary, {
    signal: options.signal, requiresClaim: Boolean(options.claim),
    publicationClaim: options.publicationClaim,
  });
  if (outputs.status === "obsolete") return { applied: false };
  return commitRunFinalization(runId, outputs.status, outputs.summary, durationMs, options, outputs.artifactIds);
}

/** A transient database failure anywhere in the settlement (a dropped
 *  connection, a deadlock) is retried with a bounded backoff instead of leaving
 *  the run non-terminal: every step is idempotent and the transaction commits
 *  whole or not at all, so a repeat converges on the same terminal row. */
function commitRunFinalization(
  ...args: Parameters<typeof commitRunFinalizationAttempt>
): Promise<FinalizeRunResult> {
  return withTransientDbRetry(`finalize run ${args[0]}`, () => commitRunFinalizationAttempt(...args));
}

async function commitRunFinalizationAttempt(
  runId: string,
  status: RunStatus,
  summary: string,
  durationMs: number,
  options: FinalizeRunOptions,
  deliveryArtifactIds: readonly string[] = [],
): Promise<FinalizeRunResult> {
  const executionGraph = executionGraphEnabled();
  const finishedWorkMode = finishedWorkRolloutMode();
  if (executionGraph) await prepareExecutionGraphSeal(runId);
  // Usage frames still in the run's capture chain land before the charge is
  // read, so the settlement prices every model call the turn made.
  await drainProviderEvents(runId);
  let applied = false;
  let effectiveStatus: "completed" | "failed" = status === "completed" ? "completed" : "failed";
  let effectiveSummary = summary;
  const shadowAudit: {
    value: { decision: "blocked" | "failed"; obligationCount: number } | null;
  } = { value: null };
  let kickSlack = false;
  let settledThreadId: string | null = null;
  let settledOrgId: string | null = null;
  let settledUserId: string | null = null;
  let settledPrompt: string | null = null;
  let settledInternal = true; // stays true unless a customer run actually finalized
  await db.transaction(async (tx) => {
    await lockFinishedWorkRun(runId, tx);
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).for("update").limit(1);
    if (!run) return; // deleted mid-flight — nothing to finalize
    if (options.claim && !(await options.claim(tx))) return; // the caller no longer owns this settlement
    if (run.status !== "queued" && run.status !== "running") return;
    settledThreadId = run.threadId;
    settledOrgId = run.orgId;
    settledUserId = run.userId;
    settledPrompt = run.prompt;
    settledInternal = isInternalRunOrigin(run.origin) || run.engine === "mock";

    // The same row lock used by acceptRunCancel linearizes Stop against this
    // terminal write. Remote file reads have already finished outside this tx.
    if (run.orgId && await hasRunCancelIntent(run.orgId, run.id, tx)) {
      effectiveStatus = "failed";
      effectiveSummary = run.status === "running" && run.commandName === "compact"
        ? COMPACT_STOPPED_WAITING_SUMMARY
        : CANCEL_SUMMARY;
      deliveryArtifactIds = [];
    }

    if (effectiveStatus === "completed" && run.orgId) {
      const state = await listFinishedWorkForRun(run.orgId, runId, tx);
      const requiredOutputs = evaluateFinishedWork({
        obligations: state.obligations.filter((row) => row.sourceKind === "sandbox_output"),
        receipts: state.receipts,
      });
      if (requiredOutputs.status === "blocked" || requiredOutputs.status === "failed") {
        effectiveStatus = "failed";
        effectiveSummary = finishedWorkFailureSummary(requiredOutputs);
      }
    }

    // Finished-work enforcement is additive and trusted-boundary-only: Phase A
    // creates no obligations, so legacy runs evaluate `not_required`. Requested
    // failures always remain failures. Only an explicit durable obligation can
    // turn a requested completion into an effective failure.
    if (effectiveStatus === "completed" && finishedWorkMode !== "off" && run.orgId) {
      const finishedWorkDecision = evaluateFinishedWork(
        await listFinishedWorkForRun(run.orgId, runId, tx),
      );
      if (
        finishedWorkMode === "shadow" &&
        (finishedWorkDecision.status === "blocked" || finishedWorkDecision.status === "failed")
      ) {
        shadowAudit.value = {
          decision: finishedWorkDecision.status,
          obligationCount: finishedWorkDecision.obligations.length,
        };
      }
      if (
        (finishedWorkDecision.status === "blocked" || finishedWorkDecision.status === "failed") &&
        finishedWorkEnforcementEnabled(run.engine, run.id)
      ) {
        effectiveStatus = "failed";
        effectiveSummary = finishedWorkFailureSummary(finishedWorkDecision);
      }
    }

    // FIRST finalizer wins (completeRun guards on a non-terminal status). A
    // concurrent second finalizer - zombie-cancel racing the reconcile loop -
    // updates zero rows; skip EVERY side-effect so it can never flip the status
    // or double-enqueue a capture for an already-settled run.
    const finalized = await completeRun(runId, effectiveStatus, effectiveSummary, durationMs, tx);
    if (!finalized) {
      settledThreadId = null;
      settledOrgId = null;
      settledUserId = null;
      settledPrompt = null;
      settledInternal = true;
      return;
    }
    applied = true;
    await releaseLeaseForRun(runId, tx);
    // Sandbox minutes: charge the settled run's lease lifetimes to its member
    // ONCE, in this transaction, for both terminal statuses. The leases were
    // just released above, so their release time is this transaction's now().
    await accrueRunSandboxMinutes(run, tx);
    if (executionGraph && run.orgId) {
      if (effectiveStatus !== "completed" && effectiveStatus !== "failed") {
        throw new Error("execution_graph_seal_requires_terminal_run");
      }
      await sealExecutionGraphAfterFinalizeTx({
        orgId: run.orgId,
        runId,
        status: effectiveStatus,
      }, tx);
    }

    // Memory capture — completed runs only, into the run's WRITE pool
    // (personal→personal, org→org), resolved from the run row's memory_scope +
    // authenticated identity. `plan` is null when memory is disabled and
    // `writePool` is null when a personal run failed closed (no auth user) —
    // either way a clean no-op. INTERNAL runs (parity canaries, e2e harnesses —
    // runs.origin, src/runs/origin.ts) never enqueue: evaluation traffic must
    // not pollute org memory. Non-SALIENT summaries (trivial one-liners,
    // apologies, raw command output) are gated out by assessCaptureSalience
    // BEFORE anything durable is written.
    if (effectiveStatus === "completed" && !isInternalRunOrigin(run.origin)) {
      const plan = resolveScopedMemory(run);
      if (plan?.writePool && assessCaptureSalience({ prompt: run.prompt, summary: effectiveSummary }).salient) {
        // Verified outcome (item 5): capture the structured facts alongside the
        // prose — artifacts published, tool counts, status/duration/engine/model,
        // and the user-correction signal — all readable in THIS transaction.
        const evidence = await collectRunEvidence(run, effectiveStatus, durationMs, tx);
        await enqueueCapture(
          runId,
          plan.writePool.identity,
          { prompt: run.prompt, summary: effectiveSummary, evidence },
          plan.scope,
          tx,
        );
      }
    }

    // Slack reply — durable for a Slack-originated run (resolved from the run's
    // thread, so replies + boot-reconciled runs both find it). Non-Slack runs
    // resolve null and enqueue nothing.
    kickSlack = (await enqueueSlackTerminalDeliveryForRunTx(tx, run, effectiveStatus, effectiveSummary, deliveryArtifactIds)) || kickSlack;

    // Automation delivery (delivery.slack) — a run fired by an automation whose
    // delivery config targets Slack posts its terminal outcome to that channel,
    // enqueued in THIS transaction (idempotent per run) so it survives a crash
    // exactly like the thread reply. Both terminal statuses deliver; the
    // allowlist is re-checked at delivery-enqueue time.
    const automation = await findScheduleForRun(runId, tx);
    if (automation) {
      await settleFiring(runId, effectiveStatus, tx);
      const target = await resolveSlackAutomationTargetForOrg(
        automation.delivery,
        automation.orgId,
        tx,
      );
      if (target) {
        const created = await enqueuePostMessageTx(tx, {
          idempotencyKey: `automation-delivery:${runId}`,
          orgId: automation.orgId,
          teamId: target.teamId,
          channel: target.channel,
          text: composeAutomationDeliveryText(automation.name, effectiveStatus, effectiveSummary),
        });
        kickSlack = kickSlack || created;
      }
    }

    // Canonical lane: enqueue canonicalization durably IN this
    // transaction, so the intent to translate commits ATOMICALLY with the terminal run
    // - a crash never leaves a settled run with no canonical history. A background
    // outbox worker translates with a source-watermark stability check + retry, and
    // marks `complete` only when the whole source was translated. Native and ACP
    // engines project events/steps into the same canonical rows.
    if (terminalCanonicalizationEligible(run.engine)) {
      await enqueueCanonicalization(runId, run.threadId, tx);
    }

    // Learning intent (self_improving 6.1): a completed, non-internal run
    // enqueues its DURABLE learning intent IN this transaction, replacing the
    // old post-commit proposeKnowledgeDraftForRun call (which left a crash
    // window between the commit and the draft). A boot-started worker
    // (learning-outbox.ts) builds the evidence-backed candidate off this
    // committed row - retryable, dead-lettering, and it NEVER fails the run.
    // INTERNAL runs (parity canaries, e2e/soak harnesses - runs.origin) are
    // excluded so evaluation traffic never becomes org learning. The verified-
    // outcome gate (6.4) still runs at build time, so an unverified completion
    // enqueues an intent but produces no candidate (a clean skip).
    if (effectiveStatus === "completed" && run.orgId && !isInternalRunOrigin(run.origin)) {
      await enqueueLearning(
        {
          runId,
          orgId: run.orgId,
          userId: run.userId,
          memoryScope: run.memoryScope,
          origin: run.origin,
        },
        tx,
      );
    }

    // Spend ledger: charge the settled run's real cost to its member ONCE, in
    // this transaction, for both terminal statuses (a failed turn still spent).
    // LAST on purpose: the account upsert takes the member's row lock, and the
    // transaction must not wait for anything else while holding it.
    // ponytail: usage a provider reports after settlement is not charged; add a
    // post-seal top-up if an engine ever streams its usage late.
    await accrueRunSpend(run, tx);
  });

  if (!applied) return { applied: false };

  if (shadowAudit.value) {
    console.info("[finished-work] shadow completion mismatch", {
      runId,
      decision: shadowAudit.value.decision,
      obligationCount: shadowAudit.value.obligationCount,
    });
  }

  // Kick the relay AFTER commit (the row isn't visible to it until then). No-op
  // when Slack isn't configured (the relay isn't running).
  if (kickSlack) kickSlackOutbox();

  // Post-commit thread signal: the run reached a terminal state, so wake any
  // connected thread stream to re-project it (final status + summary). The
  // per-run `end` bus already settles the run's transient text on the stream;
  // this carries the durable summary the `done` frame does not. Skipped when the
  // run was deleted mid-flight (settledThreadId stays null).
  if (settledThreadId && settledOrgId && !settledInternal) {
    publishRunLifecycleChange({
      orgId: settledOrgId,
      threadId: settledThreadId,
      runId,
      kind: "settled",
    });
  }

  // Follow-up suggestions (post-commit, fire-and-forget): a completed customer
  // run gets 2-3 suggested next questions appended as a native-lane frame the
  // thread stream then delivers. Strictly AFTER settle so the model call can
  // never delay the answer; internal (parity/e2e) and mock runs never generate.
  if (
    effectiveStatus === "completed" &&
    settledThreadId &&
    settledOrgId &&
    settledPrompt !== null &&
    !settledInternal
  ) {
    void recordRunFollowups(
      {
        id: runId,
        threadId: settledThreadId,
        orgId: settledOrgId,
        userId: settledUserId,
        prompt: settledPrompt,
      },
      effectiveSummary,
    );
  }
  return { applied: true, status: effectiveStatus, summary: effectiveSummary };
}
