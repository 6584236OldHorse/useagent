import type { HarnessInterimEvent } from "../engines/types";
import {
  recordedApprovalRequest,
  refuseReadOnlyRequest,
  replyToRuntimeApproval,
  type RuntimeApprovalReplyDependencies,
} from "../engines/runtime-approval";
import type { ExpectedSandboxBinding } from "../sandboxes/expected-binding";
import { bus, channel, type BusEvent } from "../worker-events";
import { appendStep } from "./repo";

/** The runtime pieces the refusal talks to; a test hands in a fake runtime and keeps the real ledger. */
export type RecoveredApprovalDependencies = Partial<RuntimeApprovalReplyDependencies>;

/** The request id an `approval.resolved` ledger event settles. */
function resolvedRequestId(payload: unknown): string | null {
  const requestId = (payload as { requestId?: unknown } | null | undefined)?.requestId;
  return typeof requestId === "string" ? requestId : null;
}

/** A read-only run's live observer (runtime-adapter.ts) declines every command
 *  and file change the runtime asks about. After a restart that observer is gone
 *  and the parked run's re-probe surfaces those requests as recovered events
 *  instead, so each one still open is declined here through the same reply
 *  path, idempotent on its receipt, and the refusal is recorded as a step like
 *  the live lane's. A reply that fails is retried by the next probe; it never
 *  blocks adoption. */
export async function refuseRecoveredApprovals(
  input: {
    readonly runId: string;
    readonly threadId: string;
    readonly sessionId: string;
    readonly expectedSandbox: ExpectedSandboxBinding | null;
    readonly events: readonly HarnessInterimEvent[];
  },
  approvals: RecoveredApprovalDependencies = {},
): Promise<void> {
  const resolved = new Set(
    input.events
      .filter((event) => event.eventType === "approval.resolved")
      .map((event) => resolvedRequestId(event.payload)),
  );
  for (const event of input.events) {
    if (event.eventType !== "approval.requested") continue;
    const request = recordedApprovalRequest(event.payload, input.sessionId);
    if (!request || resolved.has(request.id)) continue;
    try {
      const refused = await refuseReadOnlyRequest(
        {
          runId: input.runId,
          threadId: input.threadId,
          sessionId: input.sessionId,
          request,
          signal: new AbortController().signal,
          expectedSandbox: input.expectedSandbox,
        },
        (reply) => replyToRuntimeApproval(reply, approvals),
      );
      if (!refused || refused.alreadyAnswered) continue;
      const step = await appendStep(input.runId, {
        kind: refused.step.kind,
        label: refused.step.label,
        chip: refused.step.chip ?? null,
        code: null,
      });
      bus.emit(channel(input.runId), { type: "step", step } satisfies BusEvent);
    } catch (error) {
      console.error(
        `[reconcile] read-only refusal of ${request.id} for run ${input.runId} failed; the next probe retries:`,
        error,
      );
    }
  }
}
