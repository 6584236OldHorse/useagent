// A running turn follows the runtime's thread stream instead of re-reading the
// whole thread through the sandbox after every event. This applies one stream
// event to the thread state last seen, exactly as the runtime projects it at
// its pinned source (apps/server/src/orchestration/Layers/ProjectionPipeline.ts),
// for the two events a turn streams in bulk: a message (streamed text appends,
// a final text replaces) and an activity (upserted by id, ordered by sequence,
// created time and id). Anything else returns null and the caller reads a full
// snapshot: a session change, a diff, a revert, an unknown event, a final
// message that settles the turn, or a gap in the stream. So the latest turn and
// the session only ever come from the runtime's own snapshot, and a settled
// turn is always confirmed by one.
import type { RuntimeActivity, RuntimeMessage, RuntimeThreadSnapshot } from "./runtime-orchestration";

export interface RuntimeThreadEvent {
  readonly sequence: number;
  readonly type?: string;
  readonly payload?: unknown;
}

type Fields = Readonly<Record<string, unknown>>;

function fields(value: unknown): Fields | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Fields : null;
}

const isText = (value: unknown): value is string => typeof value === "string";

/** The runtime's live stream drops only tool.updated revisions that a later one in the same flush supersedes. */
function isToolUpdate(event: RuntimeThreadEvent): boolean {
  return event.type === "thread.activity-appended" &&
    fields(fields(event.payload)?.activity)?.kind === "tool.updated";
}

const createdAt = (value: object): string => String((value as { createdAt?: unknown }).createdAt ?? "");
const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const byCreatedThenId = (left: { readonly id: string }, right: { readonly id: string }): number =>
  compare(createdAt(left), createdAt(right)) || compare(left.id, right.id);
// The snapshot sorts activities by sequence first; a missing sequence (NULL) sorts first.
const activityOrder = (left: RuntimeActivity, right: RuntimeActivity): number =>
  (left.sequence ?? -Infinity) - (right.sequence ?? -Infinity) || byCreatedThenId(left, right);

function applyMessage(state: RuntimeThreadSnapshot, payload: Fields): RuntimeThreadSnapshot | null {
  const { messageId, role, text, turnId, streaming, createdAt: sentAt } = payload;
  if (
    !isText(messageId) || !isText(text) || !isText(sentAt) || typeof streaming !== "boolean" ||
    (role !== "user" && role !== "assistant" && role !== "system") || (turnId !== null && !isText(turnId))
  ) return null;
  const thread = state.thread;
  let latestTurn = thread.latestTurn;
  if (role === "assistant" && turnId !== null && latestTurn?.turnId === turnId) {
    const session = thread.session as { readonly status: string; readonly activeTurnId?: unknown } | null;
    // A final message settles the turn unless the session is still running it.
    if (!streaming && !(session?.status === "running" && session.activeTurnId === turnId)) return null;
    latestTurn = {
      ...latestTurn,
      assistantMessageId: messageId,
      requestedAt: latestTurn.requestedAt ?? sentAt,
      startedAt: latestTurn.startedAt ?? sentAt,
    };
  }
  const existing = thread.messages.find((message) => message.id === messageId);
  const message: RuntimeMessage = {
    ...existing,
    id: messageId,
    role,
    text: streaming ? `${existing?.text ?? ""}${text}` : text || (existing?.text ?? ""),
    turnId,
    streaming,
    createdAt: existing?.createdAt ?? sentAt,
  };
  const messages = existing
    ? thread.messages.map((candidate) => candidate === existing ? message : candidate)
    : [...thread.messages, message].toSorted(byCreatedThenId);
  return { ...state, thread: { ...thread, latestTurn, messages } };
}

function applyActivity(state: RuntimeThreadSnapshot, payload: Fields): RuntimeThreadSnapshot | null {
  const activity = fields(payload.activity) as RuntimeActivity | null;
  if (
    !activity || !isText(activity.id) || !isText(activity.kind) || !isText(activity.summary) ||
    !isText(activity.tone) || (activity.turnId !== null && !isText(activity.turnId))
  ) return null;
  const activities = [
    ...state.thread.activities.filter((candidate) => candidate.id !== activity.id),
    activity,
  ].toSorted(activityOrder);
  return { ...state, thread: { ...state.thread, activities } };
}

/** The thread after `event`, or null when only a full snapshot can say. */
export function applyRuntimeThreadEvent(
  state: RuntimeThreadSnapshot,
  event: RuntimeThreadEvent,
): RuntimeThreadSnapshot | null {
  // Sequences count every event the runtime records, and this stream carries
  // only the thread's detail events, less the tool updates its own coalescing
  // supersedes. A jump before a tool update is that coalescing; any other jump
  // is read as a gap, since the stream cannot say what it skipped.
  if (event.sequence !== state.snapshotSequence + 1 && !isToolUpdate(event)) return null;
  const payload = fields(event.payload);
  const next = !payload ? null
    : event.type === "thread.message-sent" ? applyMessage(state, payload)
    : event.type === "thread.activity-appended" ? applyActivity(state, payload)
    : null;
  return next && { ...next, snapshotSequence: event.sequence };
}
