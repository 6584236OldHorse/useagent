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
// The canonical lane resumes as a whole: its rows are written by one serialized writer
// (the canonicalization outbox), so delivery order equals commit and publish order.
// Native frames have two writers (this backend and the gateway process, which holds
// insert rights on provider_events and allocates its own seq), so a native seq is not
// a commit order and a live run's native frames replay from zero. A SEALED run is the
// exception: its canonicalization completed against a stable watermark (the highest
// native seq the seal counted), so a browser that holds that run up to the watermark
// holds everything the seal did, and the run resumes after the browser's cursor.
import { canonicalEventIdAt } from "./canonical-events";

/** Minted once per backend process; a cursor from another epoch is never honoured. */
export const STREAM_EPOCH = crypto.randomUUID();

export interface ResumeCursor {
  /** Newest canonical delivery seq the client holds (0: none), that row's event id,
   *  and the epoch of the backend that delivered it. */
  readonly canonicalAfter: number;
  readonly canonicalId: string | null;
  readonly epoch: string | null;
  /** Per run the client saw sealed, the newest native seq it holds. */
  readonly native: ReadonlyMap<string, number>;
}

export interface ResolvedResume {
  readonly canonicalAfter: number;
  /** The request's cursor was not provable here; replay is from zero. */
  readonly reset: boolean;
}

export const FROM_ZERO: ResolvedResume = { canonicalAfter: 0, reset: false };

/** `canonicalAfter=<deliverySeq>&canonicalId=<eventId>&epoch=<epoch>` plus the per-run
 *  `nativeAfter` entries. Anything malformed or incomplete reads as absent, never as an
 *  error; the canonical cursor needs all three of its parts. */
export function parseResumeCursor(
  canonicalAfter: string | undefined,
  canonicalId: string | undefined,
  epoch: string | undefined,
  nativeAfter?: readonly string[],
): ResumeCursor {
  const seq = canonicalAfter !== undefined && /^\d{1,15}$/.test(canonicalAfter) ? Number(canonicalAfter) : 0;
  const native = parseNativeCursors(nativeAfter);
  if (seq === 0 || !canonicalId || !epoch) return { canonicalAfter: 0, canonicalId: null, epoch: epoch || null, native };
  return { canonicalAfter: seq, canonicalId, epoch, native };
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

/** Per-run native cursors, `nativeAfter=<runId>:<seq>` repeated: the newest native seq
 *  the browser holds for a run whose canonical lane it saw complete. A malformed entry
 *  reads as absent; at most 200 are read. */
export function parseNativeCursors(values: readonly string[] | undefined): ReadonlyMap<string, number> {
  const cursors = new Map<string, number>();
  for (const value of (values ?? []).slice(0, 200)) {
    const match = /^([A-Za-z0-9._-]{1,64}):(\d{1,15})$/.exec(value);
    if (match) cursors.set(match[1]!, Number(match[2]));
  }
  return cursors;
}

/** The native seq each run's replay starts after (-1: from the start). A run's cursor is
 *  honoured only on a connection this process minted whose canonical cursor was not
 *  refused (a reset drops the browser's retained store, native frames included), and
 *  only when the run is sealed here with a watermark the cursor has reached: a browser
 *  cut off mid-replay holds less than the seal counted and replays from the start.
 *  Frames written after the seal (artifact receipts, follow-ups) carry higher seqs, so
 *  a resumed run still receives them. */
export function nativeReplayStart(
  cursors: ReadonlyMap<string, number>,
  sealedWatermarks: ReadonlyMap<string, number>,
  connection: { readonly epoch: string | null; readonly reset: boolean },
): (runId: string) => number {
  const honoured = connection.epoch === STREAM_EPOCH && !connection.reset;
  return (runId) => {
    const cursor = cursors.get(runId);
    const watermark = sealedWatermarks.get(runId);
    return honoured && cursor !== undefined && watermark !== undefined && cursor >= watermark ? cursor : -1;
  };
}
