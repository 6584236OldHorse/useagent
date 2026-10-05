// The plane's copy of one runtime thread, kept current from its stream. Every
// event carries a whole record, so applying one is an upsert by id, exactly as
// the runtime's own reducer does (apps/server/src/orchestration-v2/
// ProjectionStore.ts `applyToProjection` at the pinned source). Sequence numbers
// are global across every thread and project of the runtime, so a thread sees
// gaps by design: an item at or below the applied sequence is a duplicate (a
// resume replays from the cursor), anything above it applies, whatever the gap.
import type { V2DomainEvent, V2Projection, V2ThreadSnapshot, V2ThreadStreamItem } from "./runtime-v2-wire";

export interface V2MirrorState {
  /** The highest sequence applied: the resume cursor. */
  readonly sequence: number;
  readonly projection: V2Projection;
}

type Entity = Readonly<Record<string, unknown>> & { readonly id: string };

const ARRAY_BY_EVENT: Readonly<Record<string, string>> = {
  "run.created": "runs",
  "run.updated": "runs",
  "run-attempt.created": "attempts",
  "run-attempt.updated": "attempts",
  "node.updated": "nodes",
  "subagent.updated": "subagents",
  "provider-session.attached": "providerSessions",
  "provider-session.updated": "providerSessions",
  "provider-thread.updated": "providerThreads",
  "provider-turn.updated": "providerTurns",
  "runtime-request.updated": "runtimeRequests",
  "message.updated": "messages",
  "turn-item.updated": "turnItems",
  "plan.updated": "plans",
};

const isEntity = (value: unknown): value is Entity =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  typeof (value as { id?: unknown }).id === "string";

function upsertById(items: unknown, next: Entity): Entity[] {
  const list = Array.isArray(items) ? (items as Entity[]) : [];
  const index = list.findIndex((item) => item.id === next.id);
  if (index === -1) return [...list, next];
  const updated = [...list];
  updated[index] = next;
  return updated;
}

/** The projection after one domain event; unchanged for an event this plane does not mirror. */
export function applyV2Event(projection: V2Projection, event: V2DomainEvent): V2Projection {
  const payload = event.payload;
  if (event.type === "thread.created" || event.type.startsWith("thread.")) {
    return isEntity(payload) && payload.id === projection.thread.id
      ? { ...projection, thread: payload as V2Projection["thread"] }
      : projection;
  }
  if (event.type === "provider-session.detached") {
    const detachedId = (payload as { providerSessionId?: unknown } | null)?.providerSessionId;
    return typeof detachedId === "string"
      ? { ...projection, providerSessions: projection.providerSessions.filter((session) => session.id !== detachedId) }
      : projection;
  }
  const key = ARRAY_BY_EVENT[event.type];
  if (!key || !isEntity(payload)) return projection;
  const next = { ...projection, [key]: upsertById(projection[key], payload) } as V2Projection;
  if (event.type === "provider-thread.updated" && payload.appThreadId === projection.thread.id) {
    return { ...next, thread: { ...next.thread, activeProviderThreadId: payload.id } };
  }
  return next;
}

export function mirrorFromSnapshot(snapshot: V2ThreadSnapshot): V2MirrorState {
  return { sequence: snapshot.snapshotSequence, projection: snapshot.projection };
}

/**
 * The state after one stream item, and whether the projection changed. A
 * snapshot replaces the state unless it is older than what was applied; an
 * event at or below the cursor is a duplicate; an event before any snapshot
 * cannot apply and is left for the snapshot that must precede it.
 */
export function applyV2StreamItem(
  state: V2MirrorState | null,
  item: V2ThreadStreamItem,
  threadId: string,
): { readonly state: V2MirrorState | null; readonly changed: boolean } {
  if (item.kind === "synchronized") return { state, changed: false };
  if (item.kind === "snapshot") {
    const snapshot = item.snapshot;
    if (snapshot.projection.thread.id !== threadId) return { state, changed: false };
    if (state && snapshot.snapshotSequence < state.sequence) return { state, changed: false };
    return { state: mirrorFromSnapshot(snapshot), changed: true };
  }
  if (!state || item.sequence <= state.sequence) return { state, changed: false };
  if (item.event.threadId !== threadId) return { state: { ...state, sequence: item.sequence }, changed: false };
  const projection = applyV2Event(state.projection, item.event);
  return { state: { sequence: item.sequence, projection }, changed: projection !== state.projection };
}
