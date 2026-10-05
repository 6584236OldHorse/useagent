import type { SlackErrorClass, SlackOutboxKind } from "../../db/schema";
import type { SlackSessionStatus, SlackStreamChunk, SlackStreamTaskDisplayMode } from "../streaming";

// ---------------------------------------------------------------------------
// Boundary types for the durable Slack outbox. Kept separate from persistence
// (repo.ts) and delivery (delivery.ts) so enqueue callers depend only on shapes.
// ---------------------------------------------------------------------------

export type PostMessagePayload = {
  /** Expected tenant at enqueue time. Required for org-initiated automation
   * delivery so a later workspace rebind cannot switch credentials. */
  readonly orgId?: string;
  readonly teamId?: string;
  readonly channel: string;
  /** Ordered message texts, posted sequentially into the same thread (a long
   *  reply is CHUNKED, not truncated - see ../chunk.ts). New rows always carry
   *  `chunks`; `text` remains readable for pre-migration rows. */
  readonly chunks?: readonly string[];
  readonly text?: string;
  readonly threadTs?: string;
  readonly runId?: string;
  /** `user_mirror`: the web author's turn mirrored ahead of the bot's result.
   *  `reply_tail`: the part of an answer past what its streamed message holds,
   *  posted after that message closed (`part` orders the tails). */
  readonly messageRole?: "user_mirror" | "reply_tail";
  readonly part?: number;
  /** A row that must reach a terminal outbox state first (the same run's user
   *  mirror before its result, the closed stream before its answer's tail). */
  readonly waitForIdempotencyKey?: string;
};

export type AddReactionPayload = {
  readonly orgId?: string;
  readonly teamId?: string;
  readonly channel: string;
  readonly timestamp: string;
  readonly name: string;
};

/** Deliver a run-produced artifact into a thread. New rows reference immutable
 * shared artifact storage; stagedPath remains readable for pre-migration rows. */
export type UploadFilePayload = {
  readonly orgId: string;
  readonly teamId: string;
  readonly channel: string;
  readonly threadTs?: string;
  readonly filename: string;
  readonly title?: string;
  readonly artifactId?: string;
  readonly artifactRunId?: string;
  readonly artifactThreadId?: string;
  /** Run whose assistant turn requested this delivery. The artifact may have
   * been created by an earlier run and revised in this one. */
  readonly deliveryRunId?: string;
  readonly artifactSha256?: string;
  readonly artifactRevision?: number;
  readonly artifactStorageKey?: string;
  readonly artifactContentType?: string;
  readonly stagedPath?: string;
  readonly size: number;
};

/** Post the thread CARD (Block Kit) into a Slack thread and persist its message
 *  ts on slack_threads. One card per thread: delivery skips a thread that
 *  already has one. `rootRunId` keys the thread row the ts is stored on;
 *  `text` is the plain-text notification string. */
export type PostCardPayload = {
  readonly orgId: string;
  readonly teamId: string;
  readonly channel: string;
  readonly threadTs: string;
  readonly rootRunId: string;
  readonly blocks: readonly unknown[];
  readonly text: string;
};

/** Advance the thread card IN PLACE (chat.update). The card ts is resolved from
 *  slack_threads at delivery; a thread without a card (the post never landed,
 *  the card was deleted) gets it posted instead. `live` marks a progress
 *  revision of `runId`, dropped once that run is terminal - the terminal
 *  revision carries the settled state. */
export type UpdateCardPayload = {
  readonly orgId: string;
  readonly teamId: string;
  readonly channel: string;
  readonly threadTs: string;
  readonly rootRunId: string;
  readonly runId: string;
  readonly blocks: readonly unknown[];
  readonly text: string;
  readonly live?: boolean;
  /** Thread-wide ordering of card revisions (strictly increasing at enqueue):
   *  delivery applies a revision only if it is newer than the card's, except
   *  that a turn's terminal revision always settles its own live one. */
  readonly revision?: number;
};

export type SetSessionStatusPayload = {
  readonly orgId: string;
  readonly teamId: string;
  readonly channel: string;
  readonly threadTs: string;
  readonly runId: string;
  readonly status: SlackSessionStatus;
};

/** Free-text working status on a thread (native shimmer), rotating through
 *  `loadingMessages` when given. An empty `status` clears it. */
export type SetThreadStatusPayload = {
  readonly orgId: string;
  readonly teamId: string;
  readonly channel: string;
  readonly threadTs: string;
  readonly runId: string;
  readonly status: string;
  readonly loadingMessages?: readonly string[];
};

export type StartStreamPayload = {
  readonly orgId: string;
  readonly teamId: string;
  readonly channel: string;
  readonly threadTs: string;
  readonly runId: string;
  readonly taskDisplayMode: SlackStreamTaskDisplayMode;
  readonly chunks: readonly SlackStreamChunk[];
  /** Slack requires the recipient identity when streaming into a channel. */
  readonly recipientTeamId?: string;
  readonly recipientUserId?: string;
  /** The plain message posted instead when native streaming is unavailable
   *  (later appends and the stop update it in place). Legacy rows carried
   *  Block Kit blocks for it. */
  readonly fallbackBlocks?: readonly unknown[];
  readonly fallbackText: string;
};

export type AppendStreamPayload = {
  readonly orgId: string;
  readonly teamId: string;
  readonly channel: string;
  readonly threadTs: string;
  readonly runId: string;
  readonly chunks: readonly SlackStreamChunk[];
  /** For a narration append: the exact char offset this segment starts at.
   *  Delivery fences on it so retries can never scramble the streamed text. */
  readonly narrationOffset?: number;
  /** For a tool-card append: the watcher's batch sequence. Delivery skips a
   *  batch older than the newest one already delivered for the run, so a
   *  retried batch never restores stale card state. */
  readonly cardSeq?: number;
  /** The text the fallback message shows instead (the narration so far). */
  readonly fallbackBlocks?: readonly unknown[];
  readonly fallbackText: string;
};

export type StopStreamPayload = {
  readonly orgId: string;
  readonly teamId: string;
  readonly channel: string;
  readonly threadTs: string;
  readonly runId: string;
  /** Extra closing chunks (none today: the card carries the state; legacy
   *  rows closed task rows here). The reply markdown travels separately. */
  readonly chunks: readonly SlackStreamChunk[];
  /** The full narration the stream body should contain; delivery appends only
   *  the tail past the accepted offset (streamed_chars). */
  readonly narrationText?: string;
  /** Markdown appended after the narration tail (the reply when nothing was
   *  streamed, the failure line, or the re-stated reply when truncated). */
  readonly closingMarkdown?: string;
  /** Blocks under the closed NATIVE stream (none today; legacy rows carried a card). */
  readonly blocks?: readonly unknown[];
  readonly text: string;
  /** Full final card (with the answer) for the chat.update card fallback path.
   *  Legacy rows omit it; delivery falls back to `blocks`. */
  readonly fallbackBlocks?: readonly unknown[];
  /** The full answer, chunked - plain-text fallback when no stream/card update works. */
  readonly fallbackChunks: readonly string[];
  /** A same-run user mirror that must reach a terminal outbox state before the
   * result is eligible, so retries cannot put the result first. */
  readonly waitForIdempotencyKey?: string;
};

/** A request to durably enqueue one outbound Slack call. `idempotencyKey` makes
 *  enqueue idempotent AND bounds delivery to once per logical message. */
export type SlackOutboxEnqueue =
  | { readonly kind: "post_message"; readonly idempotencyKey: string; readonly payload: PostMessagePayload }
  | { readonly kind: "add_reaction"; readonly idempotencyKey: string; readonly payload: AddReactionPayload }
  | { readonly kind: "upload_file"; readonly idempotencyKey: string; readonly payload: UploadFilePayload }
  | { readonly kind: "post_card"; readonly idempotencyKey: string; readonly payload: PostCardPayload }
  | { readonly kind: "update_card"; readonly idempotencyKey: string; readonly payload: UpdateCardPayload }
  | { readonly kind: "set_session_status"; readonly idempotencyKey: string; readonly payload: SetSessionStatusPayload }
  | { readonly kind: "set_thread_status"; readonly idempotencyKey: string; readonly payload: SetThreadStatusPayload }
  | { readonly kind: "start_stream"; readonly idempotencyKey: string; readonly payload: StartStreamPayload }
  | { readonly kind: "append_stream"; readonly idempotencyKey: string; readonly payload: AppendStreamPayload }
  | { readonly kind: "stop_stream"; readonly idempotencyKey: string; readonly payload: StopStreamPayload };

/** How a claimed row transitioned after a delivery attempt. */
export type SlackDeliveryOutcome =
  | { readonly status: "delivered" }
  | { readonly status: "retry"; readonly errorClass: SlackErrorClass; readonly nextAttemptAt: Date }
  | { readonly status: "dead"; readonly errorClass: SlackErrorClass };

export interface ProcessResult {
  readonly delivered: number;
  readonly retried: number;
  readonly dead: number;
}

export type { SlackErrorClass, SlackOutboxKind };
