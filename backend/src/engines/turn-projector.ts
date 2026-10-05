// The turn projector applies runtime thread snapshots to the record: every
// activity revision it has not seen becomes a provider event and a step, and
// the assistant text is published as it grows. One projector's view spans a
// turn and the continuation the plane may send for it, so nothing that landed
// between the two is taken as already seen or left out of the record.
import { recordProviderEvent, recordProviderEvents, CaptureFenceError, runSettlementFence, type ProviderEventInput } from "../runs/provider-events";
import { createSecretRedactor } from "../secrets/redact";
import { activityStep, assistantText, hasOpenRuntimeToolCall, runtimeActivityProviderEvent, runtimeActivityRevision, runtimeActivityStepKey, runtimeThreadId, runtimeTurnError, runtimeTurnSettled, runtimeUserMessageId, shouldProjectRuntimeActivity, type RuntimeEngineId, type RuntimeThreadSnapshot } from "./runtime-orchestration";
import { type EngineRunContext } from "./types";
import { appendOnlyMessageCapture, runtimeRootMessageBatches } from "./runtime-root-messages";
import { turnRunIds } from "./turn-recovery";
import { runtimeUsageSignature } from "./runtime-usage-frame";
import { recordedRuntimeActivity } from "./runtime-v2-view";

type RuntimeActivity = RuntimeThreadSnapshot["thread"]["activities"][number];

export interface AppliedSnapshot {
  readonly settled: boolean;
  /** The runtime's own reason when it reported the turn failed. */
  readonly error: string | null;
  readonly toolInFlight: boolean;
  readonly delta: string | null;
}

export interface TurnProjector {
  /** `observe` sees each newly recorded activity revision before it is projected; it may answer it (awaited). */
  apply(snapshot: RuntimeThreadSnapshot, observe?: (activity: RuntimeActivity) => void | Promise<void>): Promise<AppliedSnapshot>;
  /** Activity revisions applied so far, or handed in as already seen. */
  seen(): ReadonlyMap<string, string>;
  /** The step each activity key was recorded under, so a later revision updates it instead of adding another. */
  steps(): ReadonlyMap<string, string>;
  readonly publishedText: string;
  readonly finalText: string;
}

/** The revisions a thread already holds before a turn is dispatched. */
export function activityRevisions(snapshot: RuntimeThreadSnapshot): Map<string, string> {
  return new Map(snapshot.thread.activities.map((activity) => [activity.id, runtimeActivityRevision(activity)]));
}

export function projectRuntimeAssistantText(
  state: { readonly publishedText: string; readonly finalText: string },
  text: string,
  settled: boolean,
): { readonly publishedText: string; readonly finalText: string; readonly delta: string } {
  const monotonic = text.startsWith(state.publishedText);
  return {
    publishedText: monotonic ? text : state.publishedText,
    finalText: settled ? text : state.finalText,
    delta: monotonic ? text.slice(state.publishedText.length) : "",
  };
}

export function createTurnProjector(input: {
  readonly ctx: EngineRunContext;
  readonly redact: ReturnType<typeof createSecretRedactor>;
  readonly engine: RuntimeEngineId | null;
  readonly seen: ReadonlyMap<string, string>;
  readonly steps?: ReadonlyMap<string, string>;
}): TurnProjector {
  const { ctx, redact, engine } = input;
  const revisions = new Map(input.seen);
  // Usage the thread reported before this turn. A resumed session re-reports its
  // last figures under a new activity id; that is not a model call of this run.
  const priorUsage = new Set<string>();
  const steps = new Map(input.steps ?? []);
  const threadId = runtimeThreadId(ctx);
  const capturedMessages = new Map<string, ProviderEventInput[]>();
  let publishedText = "";
  let finalText = "";
  let sealed = false;
  return {
    get publishedText() { return publishedText; },
    get finalText() { return finalText; },
    seen: () => revisions,
    steps: () => steps,
    async apply(snapshot, observe) {
      const toolInFlight = hasOpenRuntimeToolCall(snapshot.thread.activities);
      for (const batch of runtimeRootMessageBatches({
        runId: ctx.runId, threadId: ctx.threadId ?? ctx.runId, sessionId: threadId,
        userMessageIds: turnRunIds(ctx.runId).map(runtimeUserMessageId), redact: redact.text,
      }, snapshot)) {
        if (sealed) break;
        const key = batch[0]!.id;
        const capture = appendOnlyMessageCapture(batch, capturedMessages.get(key));
        if (capture.events.length === 0) continue;
        try {
          await recordProviderEvents(capture.events, { critical: true, fence: runSettlementFence(ctx.runId) });
          capturedMessages.set(key, capture.snapshot);
        } catch (error) {
          if (!(error instanceof CaptureFenceError)) throw error;
          sealed = true;
          break;
        }
      }
      for (const activity of snapshot.thread.activities) {
        const usage = input.seen.has(activity.id) ? runtimeUsageSignature(activity) : null;
        if (usage) priorUsage.add(usage);
      }
      for (const activity of snapshot.thread.activities) {
        if (sealed) break;
        const revision = runtimeActivityRevision(activity);
        if (revisions.get(activity.id) === revision) continue;
        revisions.set(activity.id, revision);
        if (!input.seen.has(activity.id) && priorUsage.has(runtimeUsageSignature(activity) ?? "")) continue;
        try {
          // Fenced by the settlement seal: once the run is settled (whichever
          // path settled it), a capture still in flight writes nothing, so the
          // charge stays what was persisted before settlement.
          await recordProviderEvent(runtimeActivityProviderEvent(ctx, threadId, activity, redact), {
            critical: activity.kind === "user-input.requested" || activity.kind === "approval.requested",
            fence: runSettlementFence(ctx.runId),
          });
        } catch (error) {
          if (!(error instanceof CaptureFenceError)) throw error;
          revisions.delete(activity.id);
          sealed = true;
          console.info(`[turn-projector] run ${ctx.runId} is settled; projection stopped`);
          break;
        }
        await observe?.(activity);
        if (!shouldProjectRuntimeActivity(activity, snapshot.thread.activities)) continue;
        const step = redact.unknown(activityStep(recordedRuntimeActivity(activity, redact), threadId, engine));
        const key = runtimeActivityStepKey(activity);
        const priorStepId = steps.get(key);
        if (priorStepId && ctx.updateStep) {
          await ctx.updateStep(priorStepId, step.code_json ?? null);
        } else {
          const stepId = await ctx.emit(step);
          if (stepId) steps.set(key, stepId);
        }
      }
      const text = redact.text(assistantText(snapshot));
      const settled = runtimeTurnSettled(snapshot);
      const projection = projectRuntimeAssistantText({ publishedText, finalText }, text, settled);
      if (projection.delta && !sealed) ctx.publishDelta?.(projection.delta);
      publishedText = projection.publishedText;
      finalText = projection.finalText;
      const error = runtimeTurnError(snapshot);
      return { settled, error: error ? redact.text(error) : null, toolInFlight, delta: projection.delta || null };
    },
  };
}
