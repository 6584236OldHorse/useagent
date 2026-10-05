import type { PermissionMode } from "@useagent/agent-client/wire";
import { resolvePreviewSandbox } from "../runs/preview-proxy";
import { approvalDecisionAllowed } from "./permission-mode";
import { resolveExpectedSandbox } from "../sandboxes/binding";
import type { ExpectedSandboxBinding } from "../sandboxes/expected-binding";
import { providerEventExists, recordProviderEvent } from "../runs/provider-events";
import { requestRuntimeEnvironment } from "./runtime-environment-client";
import type { RuntimeThreadSnapshot } from "./runtime-orchestration";

const RUNTIME_APPROVAL_TIMEOUT_MS = 15_000;

export function resolveRuntimeApprovalSandbox(
  threadId: string,
  expectedSandbox: ExpectedSandboxBinding | null | undefined,
  dependencies = {
    expected: resolveExpectedSandbox,
    preview: resolvePreviewSandbox,
  },
) {
  return expectedSandbox
    ? dependencies.expected(expectedSandbox, threadId)
    : dependencies.preview(threadId);
}

export const RUNTIME_APPROVAL_DECISIONS = [
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
] as const;

export type RuntimeApprovalDecision = (typeof RUNTIME_APPROVAL_DECISIONS)[number];

export interface RuntimeApprovalRequest {
  readonly id: string;
  readonly sessionID: string;
  readonly requestKind: "command" | "file-read" | "file-change" | "other";
  readonly detail?: string;
}

export class RuntimeApprovalError extends Error {
  constructor(
    readonly code: string,
    readonly status: 400 | 403 | 409 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

export function approvalEventId(
  runId: string,
  requestId: string,
  state: "requested" | "responding" | "responded" | "resolved",
): string {
  return `pe_${runId}_${requestId}_approval_${state}`;
}

/** What the reply path talks to; a test hands in fakes for the runtime and the ledger. */
export interface RuntimeApprovalReplyDependencies {
  readonly resolveSandbox: typeof resolveRuntimeApprovalSandbox;
  readonly request: typeof requestRuntimeEnvironment;
  readonly recordEvent: typeof recordProviderEvent;
  readonly eventExists: typeof providerEventExists;
}

export function runtimeApprovalRequest(
  activity: RuntimeThreadSnapshot["thread"]["activities"][number],
  sessionId: string,
): RuntimeApprovalRequest | null {
  if (activity.kind !== "approval.requested") return null;
  const payload = record(activity.payload);
  if (typeof payload?.requestId !== "string") return null;
  const rawKind = payload.requestKind;
  const requestKind =
    rawKind === "command" || rawKind === "file-read" || rawKind === "file-change"
      ? rawKind
      : "other";
  return {
    id: payload.requestId,
    sessionID: sessionId,
    requestKind,
    ...(typeof payload.detail === "string" ? { detail: payload.detail } : {}),
  };
}

export function validateRuntimeApprovalDecision(value: unknown): RuntimeApprovalDecision {
  if (typeof value === "string" && RUNTIME_APPROVAL_DECISIONS.includes(value as RuntimeApprovalDecision)) {
    return value as RuntimeApprovalDecision;
  }
  throw new RuntimeApprovalError(
    "approval_decision_invalid",
    400,
    `decision must be one of: ${RUNTIME_APPROVAL_DECISIONS.join(", ")}`,
  );
}

export function assertRuntimeApprovalPending(
  snapshot: RuntimeThreadSnapshot,
  sessionId: string,
  requestId: string,
): RuntimeApprovalRequest {
  const requestedAt = snapshot.thread.activities.findLastIndex((activity) => {
    const payload = record(activity.payload);
    return activity.kind === "approval.requested" && payload?.requestId === requestId;
  });
  const activity = requestedAt >= 0 ? snapshot.thread.activities[requestedAt] : undefined;
  const request = activity ? runtimeApprovalRequest(activity, sessionId) : null;
  const resolved = snapshot.thread.activities.slice(requestedAt + 1).some((candidate) => {
    const payload = record(candidate.payload);
    return candidate.kind === "approval.resolved" && payload?.requestId === requestId;
  });
  if (!request || resolved) {
    throw new RuntimeApprovalError(
      "approval_not_pending",
      409,
      "this approval is no longer pending on the active provider session",
    );
  }
  return request;
}

export async function replyToRuntimeApproval(input: {
  readonly runId: string;
  readonly threadId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly decision: unknown;
  readonly signal: AbortSignal;
  readonly expectedSandbox?: ExpectedSandboxBinding | null;
  /** The run's permission policy: a read-only run never lets a command or file change through. */
  readonly permissionMode: PermissionMode;
}, dependencies: Partial<RuntimeApprovalReplyDependencies> = {}): Promise<{ alreadyAnswered: boolean }> {
  const resolveSandbox = dependencies.resolveSandbox ?? resolveRuntimeApprovalSandbox;
  const request = dependencies.request ?? requestRuntimeEnvironment;
  const recordEvent = dependencies.recordEvent ?? recordProviderEvent;
  const eventExists = dependencies.eventExists ?? providerEventExists;
  const respondedEventId = approvalEventId(input.runId, input.requestId, "responded");
  if (await eventExists(respondedEventId)) return { alreadyAnswered: true };

  const decision = validateRuntimeApprovalDecision(input.decision);
  const sandbox = await resolveSandbox(input.threadId, input.expectedSandbox);
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(RUNTIME_APPROVAL_TIMEOUT_MS)]);
  const snapshot = await request<RuntimeThreadSnapshot>(
    sandbox,
    {
      method: "GET",
      path: `/api/orchestration/threads/${encodeURIComponent(input.sessionId)}`,
    },
    signal,
  );
  const pending = assertRuntimeApprovalPending(snapshot, input.sessionId, input.requestId);
  if (!approvalDecisionAllowed(input.permissionMode, pending, decision)) {
    throw new RuntimeApprovalError(
      "approval_refused_read_only",
      403,
      "this run is read-only: a request to run a command or change files can only be declined",
    );
  }
  if (decision === "acceptForSession") {
    // A grant the runtime keeps for the whole session must be known to us before
    // it can exist there: the intent is durable first, in its own write, and only
    // then dispatched. Should the receipt below fail to persist, the intent still
    // says a grant may stand, and a later read-only turn refuses the thread.
    await recordEvent({
      id: approvalEventId(input.runId, input.requestId, "responding"),
      runId: input.runId,
      threadId: input.threadId,
      provider: "t3",
      eventType: "approval.responding",
      nativeSessionId: input.sessionId,
      payload: { requestId: input.requestId, decision },
    }, { required: true });
  }
  await request(
    sandbox,
    {
      method: "POST",
      path: "/api/orchestration/dispatch",
      payload: {
        type: "thread.approval.respond",
        commandId: `skynet-approval-${crypto.randomUUID()}`,
        threadId: input.sessionId,
        requestId: input.requestId,
        decision,
        createdAt: new Date().toISOString(),
      },
    },
    signal,
  );
  await recordEvent({
    id: respondedEventId,
    runId: input.runId,
    threadId: input.threadId,
    provider: "t3",
    eventType: "approval.responded",
    nativeSessionId: input.sessionId,
    payload: { requestId: input.requestId, decision },
  }, { critical: true });
  if (!(await eventExists(respondedEventId))) {
    throw new RuntimeApprovalError(
      "approval_persist_failed",
      503,
      "the approval reached the provider runtime but its durable receipt could not be recorded",
    );
  }
  return { alreadyAnswered: false };
}
