// The provider runtime's orchestration protocol 2, as the plane speaks it.
// Commands go over the runtime socket (`orchestration.dispatchCommand`); HTTP
// carries only reads, auth and project mutations. Types cover the projection
// fields the plane reads and stay open for the rest, so a newer runtime that
// adds fields still decodes. Shapes follow the runtime's own contract
// (packages/contracts/src/orchestrationV2.ts at the pinned source).

export const ORCHESTRATION_PROTOCOL_VERSION = 2;
export const ORCHESTRATION_PROTOCOL_HEADER = "x-t3-orchestration-protocol";
export const ORCHESTRATION_PROTOCOL_QUERY_PARAM = "orchestrationProtocol";

export const RUNTIME_RPC = {
  dispatchCommand: "orchestration.dispatchCommand",
  subscribeThread: "orchestration.subscribeThread",
} as const;

export type V2RunStatus =
  | "preparing" | "queued" | "starting" | "running" | "waiting"
  | "completed" | "interrupted" | "failed" | "cancelled" | "rolled_back";

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed", "interrupted", "failed", "cancelled", "rolled_back",
]);

export function v2RunSettled(status: string): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

type Open = Readonly<Record<string, unknown>>;

export interface V2AppThread extends Open {
  readonly id: string;
  readonly runtimeMode?: string;
  readonly activeProviderThreadId?: string | null;
  readonly lineage?: { readonly parentThreadId: string | null; readonly relationshipToParent: string | null };
}

export interface V2Run extends Open {
  readonly id: string;
  readonly ordinal: number;
  readonly userMessageId: string;
  readonly status: V2RunStatus;
  readonly providerThreadId: string | null;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface V2Message extends Open {
  readonly id: string;
  readonly runId: string | null;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly streaming: boolean;
  readonly createdAt: string;
}

export interface V2TurnItem extends Open {
  readonly id: string;
  readonly threadId: string;
  readonly runId: string | null;
  readonly type: string;
  readonly status: string;
  readonly title: string | null;
  readonly updatedAt: string;
}

export interface V2ProviderSession extends Open {
  readonly id: string;
  readonly status: string;
  readonly lastError: string | null;
}

export interface V2ProviderThread extends Open {
  readonly id: string;
  readonly providerSessionId: string | null;
  readonly appThreadId: string | null;
  readonly contextUsage?: Open | null;
  readonly updatedAt?: string;
}

export interface V2RuntimeRequest extends Open {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
}

export interface V2Subagent extends Open {
  readonly id: string;
  readonly runId: string | null;
  readonly childThreadId: string | null;
  readonly status: string;
  readonly prompt: string;
  readonly title: string | null;
  readonly result: string | null;
  readonly updatedAt: string;
}

export interface V2Projection extends Open {
  readonly thread: V2AppThread;
  readonly runs: readonly V2Run[];
  readonly messages: readonly V2Message[];
  readonly turnItems: readonly V2TurnItem[];
  readonly providerSessions: readonly V2ProviderSession[];
  readonly providerThreads: readonly V2ProviderThread[];
  readonly runtimeRequests: readonly V2RuntimeRequest[];
  readonly subagents: readonly V2Subagent[];
}

export interface V2ThreadSnapshot {
  readonly snapshotSequence: number;
  readonly projection: V2Projection;
}

/** One domain event as the thread stream carries it. */
export interface V2DomainEvent extends Open {
  readonly type: string;
  readonly threadId: string;
  readonly payload: unknown;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isSequence = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0;

const PROJECTION_ARRAYS = [
  "runs", "messages", "turnItems", "providerSessions", "providerThreads", "runtimeRequests", "subagents",
] as const;

/** A projection with the arrays the plane reads; null when it is not one. */
export function decodeV2Projection(value: unknown): V2Projection | null {
  if (!isRecord(value) || !isRecord(value.thread) || typeof value.thread.id !== "string") return null;
  if (!Array.isArray(value.runs) || !Array.isArray(value.messages) || !Array.isArray(value.turnItems)) return null;
  const arrays = Object.fromEntries(PROJECTION_ARRAYS.map((key) => {
    const entries = value[key];
    return [key, Array.isArray(entries) ? entries.filter((entry) => isRecord(entry) && typeof entry.id === "string") : []];
  }));
  return { ...value, ...arrays } as V2Projection;
}

/** `{snapshotSequence, projection}` from a thread read; null when it is not one. */
export function decodeV2ThreadSnapshot(value: unknown): V2ThreadSnapshot | null {
  if (!isRecord(value) || !isSequence(value.snapshotSequence)) return null;
  const projection = decodeV2Projection(value.projection);
  return projection ? { snapshotSequence: value.snapshotSequence, projection } : null;
}

export type V2ThreadStreamItem =
  | { readonly kind: "snapshot"; readonly snapshot: V2ThreadSnapshot }
  | { readonly kind: "event"; readonly sequence: number; readonly event: V2DomainEvent }
  | { readonly kind: "synchronized" };

/** One thread stream value, or null for a shape this plane does not read. An
 *  event of a type it does not know still carries its sequence, so the cursor
 *  moves past it. */
export function decodeV2ThreadStreamItem(value: unknown): V2ThreadStreamItem | null {
  if (!isRecord(value)) return null;
  if (value.kind === "synchronized") return { kind: "synchronized" };
  if (value.kind === "snapshot") {
    const snapshot = decodeV2ThreadSnapshot(value);
    return snapshot ? { kind: "snapshot", snapshot } : null;
  }
  if (value.kind === "event" && isSequence(value.sequence) && isRecord(value.event) &&
    typeof value.event.type === "string" && typeof value.event.threadId === "string") {
    return { kind: "event", sequence: value.sequence, event: value.event as V2DomainEvent };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Commands. Ids are stable per plane action so a repeated dispatch is answered
// with the first one's receipt. The runtime records who created a thread or
// message; the socket handler stamps the user itself, these fields only satisfy
// the command schema.
// ---------------------------------------------------------------------------

const PROVENANCE = { createdBy: "user", creationSource: "web" } as const;

export type RuntimeCommand = Readonly<Record<string, unknown>> & {
  readonly type: string;
  readonly commandId: string;
};

export function stableRuntimeId(prefix: string, value: string): string {
  return `${prefix}-${value}`.replace(/[^a-zA-Z0-9._~-]/g, "-");
}

export interface ModelSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
}

export function buildV2ProjectCreate(input: {
  readonly commandId: string;
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string;
}): RuntimeCommand {
  return { type: "project.create", ...input };
}

export function buildV2ThreadCreate(input: {
  readonly commandId: string;
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: string;
}): RuntimeCommand {
  return {
    type: "thread.create",
    ...PROVENANCE,
    ...input,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  };
}

/** A message that starts a run now, or queues behind a run still active. */
export function buildV2MessageDispatch(input: {
  readonly commandId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly text: string;
  readonly modelSelection: ModelSelection;
}): RuntimeCommand {
  return {
    type: "message.dispatch",
    ...PROVENANCE,
    ...input,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
  };
}

export function buildV2RunInterrupt(input: {
  readonly commandId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly reason?: string;
}): RuntimeCommand {
  return { type: "run.interrupt", ...input };
}

export function buildV2RuntimeModeSet(input: {
  readonly commandId: string;
  readonly threadId: string;
  readonly runtimeMode: string;
}): RuntimeCommand {
  return { type: "thread.runtime-mode.set", ...input };
}

/** Answers an approval (`decision`) or a question (`answers`); one command for both. */
export function buildV2RuntimeRequestRespond(input: {
  readonly commandId: string;
  readonly threadId: string;
  readonly requestId: string;
  readonly decision?: string;
  readonly answers?: Readonly<Record<string, unknown>>;
}): RuntimeCommand {
  return { type: "runtime-request.respond", ...input };
}

export function buildV2ProviderSessionDetach(input: {
  readonly commandId: string;
  readonly threadId: string;
  readonly providerSessionId: string;
  readonly reason?: string;
}): RuntimeCommand {
  return { type: "provider-session.detach", ...input };
}

// ---------------------------------------------------------------------------
// Errors. A refused RPC arrives as an Exit whose cause lists `Fail` entries,
// each an error with a `_tag`; a dispatch refusal is an
// `OrchestrationV2DispatchCommandError` whose `cause` names the orchestrator's
// reason (`OrchestratorCommandPreviouslyRejectedError`, ...).
// ---------------------------------------------------------------------------

export class RuntimeRpcError extends Error {
  readonly rpcTag: string;
  /** The failing error's own `_tag`, or "Defect"/"Interrupt" when the server died or cancelled. */
  readonly errorTag: string;
  readonly detail: string | undefined;
  /** Every `_tag` (or a nested defect's `name`) in the failure, outermost first. */
  readonly causeTags: readonly string[];

  constructor(rpcTag: string, errorTag: string, message: string, detail: string | undefined, causeTags: readonly string[]) {
    super(message);
    this.name = "RuntimeRpcError";
    this.rpcTag = rpcTag;
    this.errorTag = errorTag;
    this.detail = detail;
    this.causeTags = causeTags;
  }
}

function collectTags(value: unknown, into: string[], depth = 0): void {
  if (depth > 6 || !isRecord(value)) return;
  // A nested defect is encoded as `{name, message}`, not with a `_tag`.
  const tag = typeof value._tag === "string" ? value._tag : typeof value.name === "string" ? value.name : null;
  if (tag) into.push(tag);
  for (const key of ["error", "cause", "defect"]) {
    const nested = value[key];
    if (Array.isArray(nested)) for (const entry of nested) collectTags(entry, into, depth + 1);
    else collectTags(nested, into, depth + 1);
  }
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** The error a failed Exit carries, bounded for logs and run summaries. */
export function runtimeRpcErrorFromExit(rpcTag: string, exit: unknown): RuntimeRpcError {
  const causes = isRecord(exit) && Array.isArray(exit.cause) ? exit.cause : [];
  const first = causes.find(isRecord);
  const error = isRecord(first?.error) ? first.error : isRecord(first?.defect) ? first.defect : null;
  const errorTag = text(error?._tag) ?? (first?._tag === "Interrupt" ? "Interrupt" : first?._tag === "Die" ? "Defect" : "Unknown");
  const tags: string[] = [];
  for (const cause of causes) collectTags(cause, tags);
  const detail = text(error?.detail);
  const message = text(error?.message) ?? `the provider runtime ${rpcTag} request failed`;
  const joined = detail && !message.includes(detail) ? `${message}: ${detail}` : message;
  return new RuntimeRpcError(rpcTag, errorTag, joined.length > 240 ? `${joined.slice(0, 239)}…` : joined, detail, tags);
}

/** The runtime refused the command itself (not the transport): it will refuse the same id again. */
export function runtimeCommandRefused(error: unknown): error is RuntimeRpcError {
  return error instanceof RuntimeRpcError && error.errorTag === "OrchestrationV2DispatchCommandError";
}
