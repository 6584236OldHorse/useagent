// What the plane does on its own when a provider turn settles badly, before the
// failure reaches the record. A turn that ended without an answer, or that the
// runtime reported failed for a transient provider reason, gets one
// continuation turn on the same session: the same thing a reader does by
// resending. Nothing here replays a turn that may still be running; the
// adapter keeps stalls and never-started turns on their own paths.

import { latestProviderGatewayOutcome } from "../provider-gateway/audit";

/** The runtime said the turn finished, and no assistant text ever arrived. */
export const RUNTIME_EMPTY_TERMINAL_OUTPUT_ERROR = "provider completed without assistant output";

/** The runtime reported the turn failed; the message is the provider's reason as the runtime gave it. */
export class RuntimeTurnFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeTurnFailedError";
  }
}

/** The dispatch identity of a continuation: the runtime derives its command and message ids from it, and a repeat of the original id would be answered with the original receipt. */
export function continuationRunId(runId: string, attempt: number): string {
  return `${runId}:continue-${attempt}`;
}

/** Continuation turns the plane sends by itself for one dispatched turn. */
export const TURN_RECOVERY_ATTEMPTS = 1;

export const CONTINUATION_PROMPT =
  "Your previous turn ended without a reply. Continue from where you stopped and give the final answer.";

const TRANSIENT_PROVIDER_FAILURE =
  /\b(429|502|503|504|overloaded|rate.?limit|too many requests|timed? ?out|ECONNRESET|ECONNREFUSED|EAI_AGAIN|temporarily unavailable|service unavailable|internal server error|upstream connect error)\b/i;

/** A provider failure worth one more try: capacity, throttling or a dropped connection, never a bad key or a refused request. */
export function transientProviderFailure(message: string): boolean {
  return TRANSIENT_PROVIDER_FAILURE.test(message) && !/api key|unauthorized|forbidden|invalid_request|not found|insufficient/i.test(message);
}

export interface TurnRecovery {
  /** The step the record shows for the attempt. */
  readonly label: string;
  readonly prompt: string;
  readonly delayMs: number;
  /** The answer may have landed after the drain gave up; read the thread once more before resending. */
  readonly answerMayBeLate: boolean;
}

/** The continuation for a settled failure, or null when the failure stands. Only the two outcomes the runtime itself reports qualify; a failure to read or subscribe to the thread says nothing about the turn and never does. */
export function turnRecovery(error: unknown, attempt: number): TurnRecovery | null {
  if (attempt > TURN_RECOVERY_ATTEMPTS || !(error instanceof Error)) return null;
  if (error.message === RUNTIME_EMPTY_TERMINAL_OUTPUT_ERROR) {
    return { label: "The provider finished without an answer. Asking it to continue.", prompt: CONTINUATION_PROMPT, delayMs: 0, answerMayBeLate: true };
  }
  if (error instanceof RuntimeTurnFailedError && transientProviderFailure(error.message)) {
    return { label: `The provider failed (${error.message.slice(0, 80)}). Trying once more.`, prompt: CONTINUATION_PROMPT, delayMs: 5_000, answerMayBeLate: false };
  }
  return null;
}

/** A step label naming what the gateway last saw for the run when a settled failure stands; the error itself keeps its exact message. */
export async function upstreamCauseLabel(runId: string, error: unknown): Promise<string | null> {
  if (!(error instanceof Error)) return null;
  if (error.message !== RUNTIME_EMPTY_TERMINAL_OUTPUT_ERROR && !(error instanceof RuntimeTurnFailedError)) return null;
  const cause = describeUpstreamOutcome(await latestProviderGatewayOutcome(runId).catch(() => null));
  return cause ? `Provider gateway: ${cause}` : null;
}

/** Name the cause behind a settled failure from what the gateway last saw for this run; a call still in flight says nothing yet. */
export function describeUpstreamOutcome(
  outcome: { readonly outcome: string; readonly upstreamStatus: number | null } | null,
): string | null {
  if (!outcome || outcome.outcome === "started") return null;
  if (outcome.upstreamStatus !== null) return `last provider call answered ${outcome.upstreamStatus}`;
  return outcome.outcome === "failed" ? "last provider call failed before answering" : "last provider call answered";
}
