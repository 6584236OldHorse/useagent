// Public surface of the durable Slack outbox. Callers enqueue an outbound call
// (idempotent) and the relay delivers it durably; internal repo/delivery/types
// decomposition stays private.
import { enqueue } from "./repo";
import { kickSlackOutbox } from "./delivery";
import { chunkSlackText } from "../chunk";
import { toSlackMrkdwn } from "../mrkdwn";
import { codePointCut } from "../streaming";

/** Units of the answer a stop row keeps as its notification preview. */
const STOP_PREVIEW_UNITS = 1_000;
import type { Executor } from "../../db/client";
import type { SlackStreamChunk, SlackStreamTaskDisplayMode } from "../streaming";

export {
  drainSlackDeliveryReceipts,
  startSlackOutboxRelay,
  stopSlackOutboxRelay,
  kickSlackOutbox,
  processDue,
} from "./delivery";
export {
  backfillSlackOutboxOrgScope,
  resetStuckDelivering,
  getByKey as getSlackOutbox,
  PAYLOAD_CAP as SLACK_OUTBOX_PAYLOAD_CAP,
} from "./repo";
export type { SlackOutboxRow } from "./repo";

export function slackArtifactDeliveryIdempotencyKey(input: {
  readonly teamId: string;
  readonly runId: string;
  readonly artifactId: string;
  readonly artifactRevision: number;
  readonly artifactSha256: string;
  readonly channel: string;
  readonly threadTs?: string;
}): string {
  return [
    "slack-artifact",
    input.teamId,
    input.runId,
    input.artifactId,
    input.artifactRevision,
    input.artifactSha256,
    input.channel,
    input.threadTs ?? "root",
  ].join(":");
}

/** Enqueue a run-completion reply INSIDE a caller's transaction (run
 *  finalization), so the reply commits atomically with the run reaching terminal.
 *  A long text is CHUNKED into sequential thread messages here - the one place
 *  every post_message enqueue passes through - never truncated (see ../chunk.ts).
 *  Returns whether a NEW row was created; the caller kicks the relay AFTER commit
 *  (the row isn't visible to the relay until then). */
export async function enqueuePostMessageTx(
  exec: Executor,
  entry: {
    idempotencyKey: string;
    orgId: string;
    teamId: string;
    channel: string;
    text: string;
    threadTs?: string;
    runId?: string;
    messageRole?: "user_mirror" | "reply_tail";
    part?: number;
    waitForIdempotencyKey?: string;
  },
): Promise<boolean> {
  return enqueue(
    {
      kind: "post_message",
      idempotencyKey: entry.idempotencyKey,
      payload: {
        orgId: entry.orgId,
        teamId: entry.teamId,
        channel: entry.channel,
        chunks: chunkSlackText(entry.text),
        threadTs: entry.threadTs,
        ...(entry.runId ? { runId: entry.runId } : {}),
        ...(entry.messageRole ? { messageRole: entry.messageRole } : {}),
        ...(entry.part !== undefined ? { part: entry.part } : {}),
        ...(entry.waitForIdempotencyKey ? { waitForIdempotencyKey: entry.waitForIdempotencyKey } : {}),
      },
    },
    exec,
  );
}

/** A tail of a reply INSIDE the finalize transaction: the markdown slice of the
 *  answer body past what the streamed message holds. Delivery converts it and
 *  skips whatever the stream had actually accepted by then, so a tail fixed at
 *  finalize never repeats an append that was still in flight. Each tail waits
 *  for the row before it. Returns whether a NEW row was created. */
export async function enqueueReplyTailTx(
  exec: Executor,
  entry: {
    idempotencyKey: string;
    orgId: string;
    teamId: string;
    channel: string;
    threadTs: string;
    runId: string;
    markdownText: string;
    bodyStart: number;
    coverFloor: number;
    coverCeiling: number;
    part: number;
    waitForIdempotencyKey: string;
  },
): Promise<boolean> {
  return enqueue(
    {
      kind: "post_message",
      idempotencyKey: entry.idempotencyKey,
      payload: {
        orgId: entry.orgId,
        teamId: entry.teamId,
        channel: entry.channel,
        threadTs: entry.threadTs,
        runId: entry.runId,
        messageRole: "reply_tail",
        part: entry.part,
        markdownText: entry.markdownText,
        bodyStart: entry.bodyStart,
        coverFloor: entry.coverFloor,
        coverCeiling: entry.coverCeiling,
        waitForIdempotencyKey: entry.waitForIdempotencyKey,
      },
    },
    exec,
  );
}

/** Strictly increasing card revision numbers (a millisecond clock nudged past
 *  the last one handed out), so delivery tells a retried older revision from
 *  a newer one whatever order the rows arrive in. Process-local, like the
 *  single-backend deployment this control plane requires. */
let lastCardRevision = 0;
export function nextCardRevision(): number {
  lastCardRevision = Math.max(lastCardRevision + 1, Date.now());
  return lastCardRevision;
}

/** The thread card's settled revision INSIDE a caller's transaction (run
 *  finalization), so the card commits atomically with the run reaching
 *  terminal. At delivery it advances the card in place (chat.update) or, when
 *  the thread has no card, posts it. Returns whether a NEW row was created. */
export async function enqueueUpdateCardTx(
  exec: Executor,
  entry: {
    idempotencyKey: string;
    orgId: string;
    teamId: string;
    channel: string;
    threadTs: string;
    rootRunId: string;
    runId: string;
    blocks: unknown[];
    text: string;
    /** A live progress revision, dropped once its run is terminal. */
    live?: boolean;
  },
): Promise<boolean> {
  return enqueue(
    {
      kind: "update_card",
      idempotencyKey: entry.idempotencyKey,
      payload: {
        orgId: entry.orgId,
        channel: entry.channel,
        teamId: entry.teamId,
        threadTs: entry.threadTs,
        rootRunId: entry.rootRunId,
        runId: entry.runId,
        blocks: entry.blocks,
        text: entry.text,
        revision: nextCardRevision(),
        ...(entry.live ? { live: true } : {}),
      },
    },
    exec,
  );
}

/** The thread card's first post INSIDE a caller's transaction. One card per
 *  Slack thread: the key is the thread root, and delivery skips a thread that
 *  already has its card. Returns whether a NEW row was created. */
export async function enqueuePostCardTx(
  exec: Executor,
  entry: {
    idempotencyKey: string;
    orgId: string;
    teamId: string;
    channel: string;
    threadTs: string;
    rootRunId: string;
    blocks: unknown[];
    text: string;
  },
): Promise<boolean> {
  return enqueue(
    {
      kind: "post_card",
      idempotencyKey: entry.idempotencyKey,
      payload: {
        orgId: entry.orgId,
        channel: entry.channel,
        teamId: entry.teamId,
        threadTs: entry.threadTs,
        rootRunId: entry.rootRunId,
        blocks: entry.blocks,
        text: entry.text,
      },
    },
    exec,
  );
}

export async function enqueueStopStreamTx(
  exec: Executor,
  entry: {
    idempotencyKey: string;
    orgId: string;
    teamId: string;
    channel: string;
    threadTs: string;
    runId: string;
    chunks: readonly SlackStreamChunk[];
    narrationText?: string;
    closingMarkdown?: string;
    blocks?: readonly unknown[];
    fallbackBlocks?: readonly unknown[];
    waitForIdempotencyKey?: string;
  },
): Promise<boolean> {
  // The row stores the head ONCE, as markdown; the plain form for the paths
  // without a native stream is derived at delivery. Only a bounded preview
  // (the notification text) is kept here, so it can never crowd the row.
  const preview = chunkSlackText(toSlackMrkdwn((entry.narrationText ?? "") + (entry.closingMarkdown ?? "")))[0] ?? "Done.";
  const text = preview.slice(0, codePointCut(preview, STOP_PREVIEW_UNITS));
  return enqueue(
    {
      kind: "stop_stream",
      idempotencyKey: entry.idempotencyKey,
      payload: {
        orgId: entry.orgId,
        channel: entry.channel,
        teamId: entry.teamId,
        threadTs: entry.threadTs,
        runId: entry.runId,
        chunks: entry.chunks,
        ...(entry.narrationText ? { narrationText: entry.narrationText } : {}),
        ...(entry.closingMarkdown ? { closingMarkdown: entry.closingMarkdown } : {}),
        ...(entry.blocks ? { blocks: entry.blocks } : {}),
        text,
        ...(entry.fallbackBlocks ? { fallbackBlocks: entry.fallbackBlocks } : {}),
        ...(entry.waitForIdempotencyKey
          ? { waitForIdempotencyKey: entry.waitForIdempotencyKey }
          : {}),
      },
    },
    exec,
  );
}

/** Free-text working status (native shimmer) on a thread, INSIDE a caller's
 *  transaction. Slack rotates `loadingMessages`; an empty `status` clears it. */
export async function enqueueThreadStatusTx(
  exec: Executor,
  entry: {
    idempotencyKey: string;
    orgId: string;
    teamId: string;
    channel: string;
    threadTs: string;
    runId: string;
    status: string;
    loadingMessages?: readonly string[];
  },
): Promise<boolean> {
  return enqueue(
    {
      kind: "set_thread_status",
      idempotencyKey: entry.idempotencyKey,
      payload: {
        orgId: entry.orgId,
        teamId: entry.teamId,
        channel: entry.channel,
        threadTs: entry.threadTs,
        runId: entry.runId,
        status: entry.status,
        ...(entry.loadingMessages ? { loadingMessages: entry.loadingMessages } : {}),
      },
    },
    exec,
  );
}

export async function enqueueAddReactionTx(
  exec: Executor,
  entry: {
    idempotencyKey: string;
    orgId: string;
    teamId?: string;
    channel: string;
    timestamp: string;
    name: string;
  },
): Promise<boolean> {
  return enqueue(
    {
      kind: "add_reaction",
      idempotencyKey: entry.idempotencyKey,
      payload: {
        orgId: entry.orgId,
        teamId: entry.teamId,
        channel: entry.channel,
        timestamp: entry.timestamp,
        name: entry.name,
      },
    },
    exec,
  );
}

/** Enqueue an artifact upload INSIDE a caller's transaction (run finalization),
 *  mirroring enqueuePostMessageTx: the file share commits atomically with the
 *  run reaching terminal. Returns whether a NEW row was created. */
export async function enqueueUploadFileTx(
  exec: Executor,
  entry: {
    idempotencyKey: string;
    orgId: string;
    teamId: string;
    channel: string;
    threadTs?: string;
    filename: string;
    title?: string;
    artifactId: string;
    artifactRunId: string;
    artifactThreadId: string;
    deliveryRunId: string;
    artifactSha256: string;
    artifactRevision: number;
    artifactStorageKey: string;
    artifactContentType: string;
    size: number;
  },
): Promise<boolean> {
  return enqueue(
    {
      kind: "upload_file",
      idempotencyKey: entry.idempotencyKey,
      payload: {
        orgId: entry.orgId,
        teamId: entry.teamId,
        channel: entry.channel,
        threadTs: entry.threadTs,
        filename: entry.filename,
        title: entry.title,
        artifactId: entry.artifactId,
        artifactRunId: entry.artifactRunId,
        artifactThreadId: entry.artifactThreadId,
        deliveryRunId: entry.deliveryRunId,
        artifactSha256: entry.artifactSha256,
        artifactRevision: entry.artifactRevision,
        artifactStorageKey: entry.artifactStorageKey,
        artifactContentType: entry.artifactContentType,
        size: entry.size,
      },
    },
    exec,
  );
}

/** Durably enqueue an outbound message; the relay delivers it (survives a
 *  restart). Long texts chunk exactly like enqueuePostMessageTx. Idempotent by
 *  `idempotencyKey`. */
export async function enqueuePostMessage(entry: {
  idempotencyKey: string;
  orgId?: string;
  teamId?: string;
  channel: string;
  text: string;
  threadTs?: string;
}): Promise<void> {
  const created = await enqueue({
    kind: "post_message",
    idempotencyKey: entry.idempotencyKey,
    payload: {
      orgId: entry.orgId,
      teamId: entry.teamId,
      channel: entry.channel,
      chunks: chunkSlackText(entry.text),
      threadTs: entry.threadTs,
    },
  });
  if (created) kickSlackOutbox();
}

/** Durably enqueue the thread card post (survives a restart). The relay posts
 *  it once per thread and stores the returned message ts on slack_threads.
 *  Idempotent by `idempotencyKey`. */
export async function enqueuePostCard(entry: {
  idempotencyKey: string;
  orgId: string;
  teamId: string;
  channel: string;
  threadTs: string;
  rootRunId: string;
  blocks: unknown[];
  text: string;
}): Promise<void> {
  const created = await enqueue({
    kind: "post_card",
    idempotencyKey: entry.idempotencyKey,
    payload: {
      orgId: entry.orgId,
      channel: entry.channel,
      teamId: entry.teamId,
      threadTs: entry.threadTs,
      rootRunId: entry.rootRunId,
      blocks: entry.blocks,
      text: entry.text,
    },
  });
  if (created) kickSlackOutbox();
}

/** Durably enqueue a live revision of the thread card (the watcher's progress).
 *  Dropped at delivery once `runId` is terminal. Idempotent by key. */
export async function enqueueUpdateCard(entry: {
  idempotencyKey: string;
  orgId: string;
  teamId: string;
  channel: string;
  threadTs: string;
  rootRunId: string;
  runId: string;
  blocks: unknown[];
  text: string;
}): Promise<void> {
  const created = await enqueue({
    kind: "update_card",
    idempotencyKey: entry.idempotencyKey,
    payload: {
      orgId: entry.orgId,
      channel: entry.channel,
      teamId: entry.teamId,
      threadTs: entry.threadTs,
      rootRunId: entry.rootRunId,
      runId: entry.runId,
      blocks: entry.blocks,
      text: entry.text,
      revision: nextCardRevision(),
      live: true,
    },
  });
  if (created) kickSlackOutbox();
}

export async function enqueueStartStream(entry: {
  idempotencyKey: string;
  orgId: string;
  teamId: string;
  channel: string;
  threadTs: string;
  runId: string;
  taskDisplayMode: SlackStreamTaskDisplayMode;
  chunks: readonly SlackStreamChunk[];
  recipientTeamId?: string;
  recipientUserId?: string;
  fallbackBlocks?: readonly unknown[];
  fallbackText: string;
}): Promise<void> {
  const created = await enqueue({
    kind: "start_stream",
    idempotencyKey: entry.idempotencyKey,
    payload: {
      orgId: entry.orgId,
      channel: entry.channel,
      teamId: entry.teamId,
      threadTs: entry.threadTs,
      runId: entry.runId,
      taskDisplayMode: entry.taskDisplayMode,
      chunks: entry.chunks,
      ...(entry.recipientTeamId ? { recipientTeamId: entry.recipientTeamId } : {}),
      ...(entry.recipientUserId ? { recipientUserId: entry.recipientUserId } : {}),
      ...(entry.fallbackBlocks ? { fallbackBlocks: entry.fallbackBlocks } : {}),
      fallbackText: entry.fallbackText,
    },
  });
  if (created) kickSlackOutbox();
}

export async function enqueueAppendStream(entry: {
  idempotencyKey: string;
  orgId: string;
  teamId: string;
  channel: string;
  threadTs: string;
  runId: string;
  chunks: readonly SlackStreamChunk[];
  narrationOffset?: number;
  cardSeq?: number;
  fallbackBlocks?: readonly unknown[];
  fallbackText: string;
}): Promise<void> {
  const created = await enqueue({
    kind: "append_stream",
    idempotencyKey: entry.idempotencyKey,
    payload: {
      orgId: entry.orgId,
      channel: entry.channel,
      teamId: entry.teamId,
      threadTs: entry.threadTs,
      runId: entry.runId,
      chunks: entry.chunks,
      ...(entry.narrationOffset !== undefined ? { narrationOffset: entry.narrationOffset } : {}),
      ...(entry.cardSeq !== undefined ? { cardSeq: entry.cardSeq } : {}),
      ...(entry.fallbackBlocks ? { fallbackBlocks: entry.fallbackBlocks } : {}),
      fallbackText: entry.fallbackText,
    },
  });
  if (created) kickSlackOutbox();
}

/** Durable free-text working status update (the shimmer). Idempotent by key. */
export async function enqueueThreadStatus(entry: {
  idempotencyKey: string;
  orgId: string;
  teamId: string;
  channel: string;
  threadTs: string;
  runId: string;
  status: string;
  loadingMessages?: readonly string[];
}): Promise<void> {
  const created = await enqueue({
    kind: "set_thread_status",
    idempotencyKey: entry.idempotencyKey,
    payload: {
      orgId: entry.orgId,
      teamId: entry.teamId,
      channel: entry.channel,
      threadTs: entry.threadTs,
      runId: entry.runId,
      status: entry.status,
      ...(entry.loadingMessages ? { loadingMessages: entry.loadingMessages } : {}),
    },
  });
  if (created) kickSlackOutbox();
}

/** Durably enqueue a receipt reaction. Idempotent by `idempotencyKey`. */
export async function enqueueAddReaction(entry: {
  idempotencyKey: string;
  orgId?: string;
  teamId?: string;
  channel: string;
  timestamp: string;
  name: string;
}): Promise<void> {
  const created = await enqueue({
    kind: "add_reaction",
    idempotencyKey: entry.idempotencyKey,
    payload: {
      teamId: entry.teamId,
      orgId: entry.orgId,
      channel: entry.channel,
      timestamp: entry.timestamp,
      name: entry.name,
    },
  });
  if (created) kickSlackOutbox();
}

/** Durably enqueue an artifact upload into a thread. The relay reads the same
 * immutable artifact bytes served to the browser. Idempotent by key. */
export async function enqueueUploadFile(entry: {
  idempotencyKey: string;
  orgId: string;
  teamId: string;
  channel: string;
  threadTs?: string;
  filename: string;
  title?: string;
  artifactId: string;
  artifactRunId: string;
  artifactThreadId: string;
  deliveryRunId: string;
  artifactSha256: string;
  artifactRevision: number;
  artifactStorageKey: string;
  artifactContentType: string;
  size: number;
}): Promise<void> {
  const created = await enqueue({
    kind: "upload_file",
    idempotencyKey: entry.idempotencyKey,
    payload: {
      orgId: entry.orgId,
      teamId: entry.teamId,
      channel: entry.channel,
      threadTs: entry.threadTs,
      filename: entry.filename,
      title: entry.title,
      artifactId: entry.artifactId,
      artifactRunId: entry.artifactRunId,
      artifactThreadId: entry.artifactThreadId,
      deliveryRunId: entry.deliveryRunId,
      artifactSha256: entry.artifactSha256,
      artifactRevision: entry.artifactRevision,
      artifactStorageKey: entry.artifactStorageKey,
      artifactContentType: entry.artifactContentType,
      size: entry.size,
    },
  });
  if (created) kickSlackOutbox();
}
