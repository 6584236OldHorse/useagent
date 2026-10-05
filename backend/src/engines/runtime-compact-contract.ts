import type { HarnessSession } from "@useagent/agent-harness/canonical";

export const COMPACT_STOPPED_WAITING_SUMMARY =
  "Stopped by user. Stopped waiting for native compaction, which may still finish.";
export const RUNTIME_COMPACT_TIMEOUT_MS = 10 * 60_000;
export const COMPACT_TIMED_OUT_WAITING_SUMMARY =
  "Stopped waiting after 10 minutes. Native compaction may still finish.";

export function compactRecoveryDeadlineMs(fallbackAnchorMs: number, promptDeliveredAtMs?: number): number {
  return (promptDeliveredAtMs ?? fallbackAnchorMs) + RUNTIME_COMPACT_TIMEOUT_MS;
}

export function compactWaitTimeoutSummary(
  commandName: string | null,
  timedOut: boolean,
  error: unknown,
): string | null {
  if (commandName !== "compact") return null;
  return timedOut || (error instanceof Error && error.message === COMPACT_TIMED_OUT_WAITING_SUMMARY)
    ? COMPACT_TIMED_OUT_WAITING_SUMMARY
    : null;
}

export function compactCommandIdentityIsCurrent(
  command: {
    readonly provider: string | null;
    readonly sessionId: string | null;
    readonly catalogRevision: number | null;
  },
  engine: string,
  session: Pick<HarnessSession, "nativeSessionId">,
): boolean {
  return command.provider === engine &&
    command.sessionId === session.nativeSessionId &&
    command.catalogRevision !== null;
}
