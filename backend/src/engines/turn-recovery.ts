// What the plane does on its own when a provider turn settles badly, before the
// failure reaches the record. A turn that ended without an answer, or that the
// runtime reported failed for a transient provider reason, gets one
// continuation turn on the same session: the same thing a reader does by
// resending. Nothing here replays a turn that may still be running; the
// adapter keeps stalls and never-started turns on their own paths.

import { latestProviderGatewayOutcome } from "../provider-gateway/audit";

/** The runtime said the turn finished, and no assistant text ever arrived. */
export const RUNTIME_EMPTY_TERMINAL_OUTPUT_ERROR = "provider completed without assistant output";

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
}

/** The continuation for a settled failure, or null when the failure stands. */
export function turnRecovery(error: unknown, attempt: number): TurnRecovery | null {
  if (attempt > TURN_RECOVERY_ATTEMPTS) return null;
  const message = error instanceof Error ? error.message : String(error);
  if (message === RUNTIME_EMPTY_TERMINAL_OUTPUT_ERROR) {
    return { label: "The provider finished without an answer. Asking it to continue.", prompt: CONTINUATION_PROMPT, delayMs: 0 };
  }
  if (transientProviderFailure(message)) {
    return { label: `The provider failed (${message.slice(0, 80)}). Trying once more.`, prompt: CONTINUATION_PROMPT, delayMs: 5_000 };
  }
  return null;
}

/** A settled failure names what the gateway last saw for the run, so the record says why. */
export async function withUpstreamCause(runId: string, error: unknown): Promise<unknown> {
  if (!(error instanceof Error)) return error;
  if (error.message !== RUNTIME_EMPTY_TERMINAL_OUTPUT_ERROR && !transientProviderFailure(error.message)) return error;
  const cause = describeUpstreamOutcome(await latestProviderGatewayOutcome(runId).catch(() => null));
  return cause ? new Error(`${error.message} (${cause})`) : error;
}

/** Name the cause behind a settled failure from what the gateway last saw for this run. */
export function describeUpstreamOutcome(
  outcome: { readonly outcome: string; readonly upstreamStatus: number | null } | null,
): string | null {
  if (!outcome) return null;
  if (outcome.upstreamStatus !== null) return `last provider call answered ${outcome.upstreamStatus}`;
  return outcome.outcome === "failed" ? "last provider call failed before answering" : "last provider call answered";
}
