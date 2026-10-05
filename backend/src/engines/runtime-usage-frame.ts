// Usage frame for the provider runtime lane. After every model call the runtime
// reports how full the model's context is as a `context-window.updated`
// activity (Codex from the app-server's thread/tokenUsage/updated notification,
// Claude from the SDK result usage). It is stored as the `part.step-finish`
// usage frame the other engines already emit, so the composer's context ring,
// the fleet ledger and spend accrual all read one shape: `tokens.total` is that
// call's tokens (the context in use), `tokens.cache.read` the cache-read share,
// `contextWindow` the model's window. The activity keeps its ledger id, so a
// revision replaces the row and replay or recovery never adds a second frame.
import type { ProviderEventInput } from "../runs/provider-events";
import type { SecretRedactor } from "../secrets/redact";
import type { RuntimeActivity } from "./runtime-orchestration";
import type { EngineRunContext } from "./types";

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

export function runtimeUsageProviderEvent(
  ctx: Pick<EngineRunContext, "runId" | "threadId">,
  sessionId: string,
  activity: RuntimeActivity,
  redact: Pick<SecretRedactor, "unknown">,
): ProviderEventInput | null {
  if (activity.kind !== "context-window.updated") return null;
  const usage = activity.payload && typeof activity.payload === "object" && !Array.isArray(activity.payload)
    ? (activity.payload as Readonly<Record<string, unknown>>)
    : null;
  const total = count(usage?.usedTokens);
  if (!usage || !total) return null;
  return {
    id: `pe_${ctx.runId}_t3_${activity.id}`,
    runId: ctx.runId,
    threadId: ctx.threadId ?? ctx.runId,
    provider: "t3",
    eventType: "part.step-finish",
    nativeSessionId: sessionId,
    nativeParentSessionId: null,
    // No assistant message finishes here, so the canonical lane keeps treating
    // the frame as a usage diagnostic rather than a message boundary.
    nativeMessageId: null,
    nativePartId: activity.id,
    nativeCallId: null,
    payload: {
      tokens: {
        input: count(usage.inputTokens),
        output: count(usage.outputTokens),
        reasoning: count(usage.reasoningOutputTokens),
        cache: { read: count(usage.cachedInputTokens) },
        total,
      },
      contextWindow: count(usage.maxTokens),
      activity: redact.unknown(activity),
    },
  };
}

/** The figures a usage activity reports, as one comparable value (null for any
 * other activity). On thread resume Codex re-reports the last call's usage under
 * a new activity id; equal figures mean no model call happened in between, since
 * every call adds input. */
export function runtimeUsageSignature(activity: RuntimeActivity): string | null {
  if (activity.kind !== "context-window.updated") return null;
  const usage = activity.payload && typeof activity.payload === "object" && !Array.isArray(activity.payload)
    ? (activity.payload as Readonly<Record<string, unknown>>)
    : null;
  if (!usage) return null;
  return JSON.stringify([
    usage.usedTokens, usage.totalProcessedTokens, usage.inputTokens,
    usage.cachedInputTokens, usage.outputTokens, usage.reasoningOutputTokens,
  ]);
}
