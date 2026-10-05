// Resume cursor for the thread stream's canonical lane. A browser that already holds
// part of a thread (a retained store, or a reconnect) tells the server the newest
// canonical row it has, and the server replays only what is newer. The cursor is
// honoured only when it was minted by this backend process (`epoch`) and names a row
// that exists here with the same event id; anything else (a restart, a restore,
// another database, a replaced row) refuses it: the replay is then from zero and the
// `resume` frame says so, and the client drops what it retained before applying the
// replay. Absent or malformed cursors mean from zero, exactly what an older client
// gets.
//
// Only the canonical lane resumes. Its rows are written by one serialized writer (the
// canonicalization outbox), so delivery order equals commit and publish order. Native
// frames have two writers (this backend and the gateway process, which holds insert
// rights on provider_events and allocates its own seq), so a native seq is not a
// commit order and native frames replay from zero on every connection.
import { canonicalEventIdAt } from "./canonical-events";

/** Minted once per backend process; a cursor from another epoch is never honoured. */
export const STREAM_EPOCH = crypto.randomUUID();

export interface ResumeCursor {
  /** Newest canonical delivery seq the client holds (0: none), that row's event id,
   *  and the epoch of the backend that delivered it. */
  readonly canonicalAfter: number;
  readonly canonicalId: string | null;
  readonly epoch: string | null;
}

export interface ResolvedResume {
  readonly canonicalAfter: number;
  /** The request's cursor was not provable here; replay is from zero. */
  readonly reset: boolean;
}

export const FROM_ZERO: ResolvedResume = { canonicalAfter: 0, reset: false };

/** `canonicalAfter=<deliverySeq>&canonicalId=<eventId>&epoch=<epoch>`. Anything
 *  malformed or incomplete reads as absent, never as an error. */
export function parseResumeCursor(
  canonicalAfter: string | undefined,
  canonicalId: string | undefined,
  epoch: string | undefined,
): ResumeCursor {
  const seq = canonicalAfter !== undefined && /^\d{1,15}$/.test(canonicalAfter) ? Number(canonicalAfter) : 0;
  if (seq === 0 || !canonicalId || !epoch) return { canonicalAfter: 0, canonicalId: null, epoch: null };
  return { canonicalAfter: seq, canonicalId, epoch };
}

/** Honour the cursor only when this process minted it and its row is still here. */
export async function resolveResumeCursor(threadId: string, requested: ResumeCursor): Promise<ResolvedResume> {
  if (requested.canonicalAfter === 0) return FROM_ZERO;
  if (requested.epoch !== STREAM_EPOCH) return { ...FROM_ZERO, reset: true };
  const eventId = await canonicalEventIdAt(threadId, requested.canonicalAfter);
  if (eventId === null || eventId !== requested.canonicalId) return { ...FROM_ZERO, reset: true };
  return { canonicalAfter: requested.canonicalAfter, reset: false };
}

/** The wire shape of the `resume` frame (the first frame of every connection). */
export function resumeFramePayload(threadId: string, resolved: ResolvedResume) {
  return { threadId, resume: { canonicalAfter: resolved.canonicalAfter, reset: resolved.reset, epoch: STREAM_EPOCH } };
}
