import { EventEmitter } from "node:events";
import { and, asc, count, eq, gt, lte } from "drizzle-orm";
import { NATIVE_SCHEMA_VERSION } from "@useagent/agent-client/wire";
import { type NativeHoldEntry, nativeHoldDigest } from "@useagent/agent-client";
import type { NativeFrame } from "@useagent/agent-client/wire";
import { db } from "../db/client";
import { providerEvents } from "../db/schema";

// ---------------------------------------------------------------------------
// Native-event streaming lane (north star "Canonical Events"): the versioned
// durable projection of the lossless provider_events capture, streamed to
// clients alongside — never replacing — the step/delta/done projection.
//
// Kept in its own module with a DEDICATED bus so the lossless native lane stays
// decoupled from the worker's step bus (and avoids an engines↔worker import
// cycle: provider-events → native-events → db, nothing back into worker).
// ---------------------------------------------------------------------------

// The native-event frame wire shape + schema version are the agent-client wire
// contract (shared verbatim with the browser client's parser); re-exported so
// backend callers keep importing them from here alongside the capture/replay
// machinery below. Bumping the version stays a backend concern (clients upcast).
export { NATIVE_SCHEMA_VERSION };
export type { NativeFrame };

type ProviderEventRow = typeof providerEvents.$inferSelect;

/** Live signal for newly-persisted native events, keyed per run. */
const nativeBus = new EventEmitter();
nativeBus.setMaxListeners(0);

export const nativeChannel = (runId: string): string => `native:${runId}`;

/** Subscribe to a run's live native frames. Returns an unsubscribe fn. */
export function subscribeNative(
  runId: string,
  fn: (frame: NativeFrame) => void,
): () => void {
  const ch = nativeChannel(runId);
  nativeBus.on(ch, fn);
  return () => nativeBus.off(ch, fn);
}

/** Publish a freshly-persisted native frame to live subscribers. */
export function publishNativeFrame(runId: string, frame: NativeFrame): void {
  nativeBus.emit(nativeChannel(runId), frame);
}

/** Parse a stored bounded payload. Legacy rows may contain invalid sliced JSON,
 *  so retain the compatibility marker instead of throwing. */
function parseStoredPayload(text: string | null): unknown {
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { _unparseable: true, _bytes: text.length };
  }
}

/** Build a frame from the fields written at capture time (live path). */
export function makeNativeFrame(fields: {
  eventId: string;
  seq: number;
  provider: string;
  eventType: string;
  sessionId: string | null;
  parentSessionId: string | null;
  messageId: string | null;
  partId: string | null;
  callId: string | null;
  payloadText: string | null;
}): NativeFrame {
  return {
    schemaVersion: NATIVE_SCHEMA_VERSION,
    eventId: fields.eventId,
    seq: fields.seq,
    provider: fields.provider,
    eventType: fields.eventType,
    native: {
      sessionId: fields.sessionId,
      parentSessionId: fields.parentSessionId,
      messageId: fields.messageId,
      partId: fields.partId,
      callId: fields.callId,
    },
    payload: parseStoredPayload(fields.payloadText),
  };
}

function rowToNativeFrame(row: ProviderEventRow): NativeFrame {
  return makeNativeFrame({
    eventId: row.id,
    seq: row.seq,
    provider: row.provider,
    eventType: row.eventType,
    sessionId: row.nativeSessionId,
    parentSessionId: row.nativeParentSessionId,
    messageId: row.nativeMessageId,
    partId: row.nativePartId,
    callId: row.nativeCallId,
    payloadText: row.payload,
  });
}

/**
 * Replay a run's native frames after a cursor. `cursorSeq` is the last `seq` the
 * client has seen (default -1 → replay from the start, since seq begins at 0);
 * returns frames with seq strictly greater, ordered ascending. Because
 * provider_events is upserted by native id, each `eventId` appears at most once
 * (at its latest revision), so the snapshot is already deduplicated.
 */
export async function getNativeFramesSince(
  runId: string,
  cursorSeq: number,
  limit?: number,
): Promise<NativeFrame[]> {
  const base = db.select().from(providerEvents)
    .where(and(eq(providerEvents.runId, runId), gt(providerEvents.seq, cursorSeq)))
    .orderBy(asc(providerEvents.seq));
  const rows = limit === undefined ? await base : await base.limit(limit);
  return rows.map(rowToNativeFrame);
}

export async function countNativeFrames(runId: string): Promise<number> {
  const [row] = await db.select({ count: count() }).from(providerEvents)
    .where(eq(providerEvents.runId, runId));
  return row?.count ?? 0;
}

/** What a browser reports it holds of one sealed run's native lane: its newest seq and the
 *  digest of the (eventId, seq) pairs it retained. */
export interface NativeHold {
  readonly seq: number;
  readonly digest: string;
}

/** A resumed run: the pairs the browser proved it holds, and the frames above its cursor. */
export interface ResumedNativeLane {
  readonly retained: readonly NativeHoldEntry[];
  readonly frames: readonly NativeFrame[];
}

/** Resume sealed runs' native lanes after the browser's cursors, in ONE read-only
 *  repeatable-read transaction so the check and the read see the same rows. A run is
 *  honoured when the digest of this database's (id, seq) pairs at or below its cursor equals
 *  the browser's hold digest; its value is then those pairs (so the connection can treat
 *  them as sent) and the frames above the cursor. A run whose hold differs (a frame
 *  committed below the cursor after the hold was taken, a revision that moved a frame) is
 *  absent from the result and replays from the start. */
export async function resumeNativeLanes(
  holds: ReadonlyMap<string, NativeHold>,
): Promise<ReadonlyMap<string, ResumedNativeLane>> {
  const resumed = new Map<string, ResumedNativeLane>();
  if (holds.size === 0) return resumed;
  await db.transaction(async (tx) => {
    for (const [runId, hold] of holds) {
      const rows = await tx.select({ id: providerEvents.id, seq: providerEvents.seq }).from(providerEvents)
        .where(and(eq(providerEvents.runId, runId), lte(providerEvents.seq, hold.seq)));
      const retained = rows.map((row) => ({ eventId: row.id, seq: row.seq }));
      if (nativeHoldDigest(retained) !== hold.digest) continue;
      const above = await tx.select().from(providerEvents)
        .where(and(eq(providerEvents.runId, runId), gt(providerEvents.seq, hold.seq)))
        .orderBy(asc(providerEvents.seq));
      resumed.set(runId, { retained, frames: above.map(rowToNativeFrame) });
    }
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
  return resumed;
}
