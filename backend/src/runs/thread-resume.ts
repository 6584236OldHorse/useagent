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
// native seq the seal counted). The watermark alone is not proof that a browser holds
// every frame below its cursor (the seal drains only this process's writes; the other
// writer can commit a lower seq after it), so the browser also reports a digest of the
// (eventId, seq) pairs it holds, and the run resumes after the cursor only when this
// database's rows at or below the cursor are exactly that set, checked in the same
// snapshot that reads the rows above it.
import { NATIVE_CURSOR_LIMIT, type NativeHoldEntry } from "@useagent/agent-client";
import { canonicalEventIdAt } from "./canonical-events";
import { getNativeFramesSince, type NativeFrame, type NativeHold, resumeNativeLanes } from "./native-events";

/** Minted once per backend process; a cursor from another epoch is never honoured. */
export const STREAM_EPOCH = crypto.randomUUID();

export interface ResumeCursor {
  /** Newest canonical delivery seq the client holds (0: none), that row's event id,
   *  and the epoch of the backend that delivered it. */
  readonly canonicalAfter: number;
  readonly canonicalId: string | null;
  readonly epoch: string | null;
  /** Per run the client saw sealed, what it holds of the run's native lane. */
  readonly native: ReadonlyMap<string, NativeHold>;
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

/** Per-run native cursors, `nativeAfter=<runId>:<seq>:<digest>` repeated, for the runs
 *  whose canonical lane the browser saw complete: the newest seq it holds and the digest
 *  of the (eventId, seq) pairs it holds (`nativeHoldDigest` in the client library). A
 *  malformed entry reads as absent; at most NATIVE_CURSOR_LIMIT are read (the client sends
 *  no more). */
export function parseNativeCursors(values: readonly string[] | undefined): ReadonlyMap<string, NativeHold> {
  const cursors = new Map<string, NativeHold>();
  for (const value of (values ?? []).slice(0, NATIVE_CURSOR_LIMIT)) {
    const match = /^([A-Za-z0-9._-]{1,64}):(\d{1,15}):([0-9a-f]{16})$/.exec(value);
    if (match) cursors.set(match[1]!, { seq: Number(match[2]), digest: match[3]! });
  }
  return cursors;
}

/** What one connection replays of each run's native lane. */
export interface NativeReplay {
  /** The (eventId, seq) pairs the browser proved it holds for a resumed run (none otherwise),
   *  for the connection to treat as already sent. */
  retained(runId: string): readonly NativeHoldEntry[];
  /** The frames to send: those above an honoured cursor, else the run's whole lane. */
  replay(runId: string): Promise<readonly NativeFrame[]>;
}

/** A run's cursor is honoured only on a connection this process minted whose canonical
 *  cursor was not refused (a reset drops the browser's retained store, native frames
 *  included), only when the run is sealed here with a watermark the cursor has reached (a
 *  browser cut off mid-replay holds less than the seal counted), and only when the digest
 *  of this database's rows at or below the cursor equals the browser's hold digest, read in
 *  the same snapshot as the rows above the cursor: a frame the other writer committed below
 *  the cursor after the hold was taken, or a revision that moved a frame, sends the run
 *  back to a full replay. Frames above the cursor (artifact receipts, follow-ups written
 *  after the seal) still arrive. Only this thread's sealed runs are ever looked up. */
export async function resolveNativeResume(
  cursors: ReadonlyMap<string, NativeHold>,
  sealedWatermarks: ReadonlyMap<string, number>,
  connection: { readonly epoch: string | null; readonly reset: boolean },
  resume: typeof resumeNativeLanes = resumeNativeLanes,
): Promise<NativeReplay> {
  const candidates = new Map<string, NativeHold>();
  if (connection.epoch === STREAM_EPOCH && !connection.reset) {
    for (const [runId, hold] of cursors) {
      const watermark = sealedWatermarks.get(runId);
      if (watermark !== undefined && hold.seq >= watermark) candidates.set(runId, hold);
    }
  }
  const resumed = await resume(candidates);
  return {
    retained: (runId) => resumed.get(runId)?.retained ?? [],
    replay: (runId) => {
      const lane = resumed.get(runId);
      return lane ? Promise.resolve(lane.frames) : getNativeFramesSince(runId, -1);
    },
  };
}
