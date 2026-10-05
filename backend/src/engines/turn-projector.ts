// The turn projector applies runtime thread snapshots to the record: every
// activity revision it has not seen becomes a provider event and a step, and
// the assistant text is published as it grows. One projector's view spans a
// turn and the continuation the plane may send for it, so nothing that landed
// between the two is taken as already seen or left out of the record.
import { recordProviderEvent, CaptureFenceError, runSettlementFence } from "../runs/provider-events";
import { createSecretRedactor } from "../secrets/redact";
import { activityStep, assistantText, hasOpenRuntimeToolCall, runtimeActivityProviderEvent, runtimeActivityRevision, runtimeActivityStepKey, runtimeThreadId, runtimeTurnError, runtimeTurnSettled, shouldProjectRuntimeActivity, type RuntimeEngineId, type RuntimeThreadSnapshot } from "./runtime-orchestration";
import { type EngineRunContext } from "./types";

type RuntimeActivity = RuntimeThreadSnapshot["thread"]["activities"][number];

export interface AppliedSnapshot {
  readonly settled: boolean;
  /** The runtime's own reason when it reported the turn failed. */
  readonly error: string | null;
  readonly toolInFlight: boolean;
  readonly delta: string | null;
}

export interface TurnProjector {
  /** `options.signal`, once aborted, fences the projection: no further activity
   *  is recorded or projected and no delta is published, so a caller that gave
   *  up waiting can be sure nothing lands after its deadline. */
  apply(
    snapshot: RuntimeThreadSnapshot,
    observe?: (activity: RuntimeActivity) => void,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AppliedSnapshot>;
  /** Activity revisions applied so far, or handed in as already seen, each with the snapshot that carried it. */
  seen(): ReadonlyMap<string, SeenRevision>;
  /** The step each activity key was recorded under, so a later revision updates it instead of adding another. */
  steps(): ReadonlyMap<string, string>;
  readonly publishedText: string;
  readonly finalText: string;
  /** Whether a snapshot applied so far showed the runtime turn settled
   *  (completed, interrupted or failed): a turn that never did may still be running. */
  readonly settled: boolean;
}

/** What a projector knows of an activity: the revision recorded and the
 *  snapshot sequence (the runtime's own thread clock) that carried it. */
export interface SeenRevision {
  readonly revision: string;
  readonly at: number;
}

/** The revisions a thread already holds before a turn is dispatched. */
export function activityRevisions(snapshot: RuntimeThreadSnapshot): Map<string, SeenRevision> {
  return new Map(snapshot.thread.activities.map((activity) => [
    activity.id,
    { revision: runtimeActivityRevision(activity), at: snapshot.snapshotSequence },
  ]));
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
  readonly seen: ReadonlyMap<string, SeenRevision>;
  readonly steps?: ReadonlyMap<string, string>;
}): TurnProjector {
  const { ctx, redact, engine } = input;
  const revisions = new Map(input.seen);
  const steps = new Map(input.steps ?? []);
  const threadId = runtimeThreadId(ctx);
  let publishedText = "";
  let finalText = "";
  let sealed = false;
  let settledSeen = false;
  return {
    get publishedText() { return publishedText; },
    get finalText() { return finalText; },
    get settled() { return settledSeen; },
    seen: () => revisions,
    steps: () => steps,
    async apply(snapshot, observe, options) {
      const signal = options?.signal;
      const toolInFlight = hasOpenRuntimeToolCall(snapshot.thread.activities);
      for (const activity of snapshot.thread.activities) {
        // Checked before the revision is marked, so an activity fenced out here
        // is still unseen for a later projection instead of silently lost.
        if (signal?.aborted || sealed) break;
        // A revision applies only from a snapshot newer than the one that
        // recorded the activity, and only when it differs. The snapshot
        // sequence is the runtime's thread clock, so it orders the record even
        // for activities that carry no sequence of their own: a replay adds
        // nothing, and a projection resuming with an older snapshot after the
        // stop cleanup landed a newer one applies nothing older.
        const revision = runtimeActivityRevision(activity);
        const known = revisions.get(activity.id);
        if (known && (known.revision === revision || snapshot.snapshotSequence <= known.at)) continue;
        revisions.set(activity.id, { revision, at: snapshot.snapshotSequence });
        try {
          // Fenced by the settlement seal: once the run is settled (whichever
          // path settled it), a capture still in flight writes nothing.
          await recordProviderEvent(runtimeActivityProviderEvent(ctx, threadId, activity, redact), {
            critical: activity.kind === "user-input.requested" || activity.kind === "approval.requested",
            fence: runSettlementFence(ctx.runId),
          });
        } catch (error) {
          // The marker goes with the failed write, whatever failed it, so the
          // activity stays unseen for the next projection (the stop cleanup's
          // re-read, a continuation) instead of silently lost.
          if (known) revisions.set(activity.id, known);
          else revisions.delete(activity.id);
          if (!(error instanceof CaptureFenceError)) throw error;
          sealed = true;
          console.info(`[turn-projector] run ${ctx.runId} is settled; projection stopped`);
          break;
        }
        observe?.(activity);
        if (!shouldProjectRuntimeActivity(activity, snapshot.thread.activities)) continue;
        const step = redact.unknown(activityStep(activity, threadId, engine));
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
      settledSeen ||= settled;
      const projection = projectRuntimeAssistantText({ publishedText, finalText }, text, settled);
      if (projection.delta && !signal?.aborted && !sealed) ctx.publishDelta?.(projection.delta);
      publishedText = projection.publishedText;
      finalText = projection.finalText;
      const error = runtimeTurnError(snapshot);
      return { settled, error: error ? redact.text(error) : null, toolInFlight, delta: projection.delta || null };
    },
  };
}
