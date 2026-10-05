// Resume cursors for the thread stream. A browser that already holds part of a
// thread (a retained store, or a reconnect) tells the server what it has, and the
// server replays only what is newer. A cursor is honoured only when the exact row it
// names exists here (same delivery seq and event id, same run seq and event id), so
// history from a rollback, a restore or another database is refused as a whole: the
// replay is then from zero and the `resume` frame says so, and the client drops what
// it retained before applying the replay. Absent or malformed cursors mean from zero,
// exactly what an older client gets.
import { canonicalEventIdAt } from "./canonical-events";
import { nativeEventIdsAt } from "./native-events";

export interface NativeCursor {
  readonly seq: number;
  readonly eventId: string;
}

export interface ResumeCursors {
  /** Newest canonical delivery seq the client holds (0: none) and that row's event id. */
  readonly canonicalAfter: number;
  readonly canonicalId: string | null;
  /** Newest native frame the client holds, per run (absent: none for that run). */
  readonly nativeAfter: ReadonlyMap<string, NativeCursor>;
}

export interface ResolvedResume {
  readonly canonicalAfter: number;
  readonly nativeAfter: ReadonlyMap<string, number>;
  /** The request's cursors were not all provable here; replay is from zero. */
  readonly reset: boolean;
}

export const FROM_ZERO: ResolvedResume = { canonicalAfter: 0, nativeAfter: new Map(), reset: false };

function nonNegativeInt(value: string | undefined): number | null {
  return value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : null;
}

/** `canonicalAfter=<deliverySeq>&canonicalId=<eventId>&nativeAfter=<runId>:<seq>:<eventId>`
 *  (`nativeAfter` repeated per run; the event id may itself contain colons). Anything
 *  malformed reads as absent, never as an error: a bad cursor costs a full replay. */
export function parseResumeCursors(
  canonicalAfter: string | undefined,
  canonicalId: string | undefined,
  nativeAfter: readonly string[] | undefined,
): ResumeCursors {
  const native = new Map<string, NativeCursor>();
  for (const part of nativeAfter ?? []) {
    const [runId, seqText, ...rest] = part.split(":");
    const seq = nonNegativeInt(seqText);
    const eventId = rest.join(":");
    if (runId && seq !== null && eventId) native.set(runId, { seq, eventId });
  }
  const canonical = nonNegativeInt(canonicalAfter) ?? 0;
  return {
    canonicalAfter: canonicalId ? canonical : 0,
    canonicalId: canonical > 0 && canonicalId ? canonicalId : null,
    nativeAfter: native,
  };
}

/** Honour the cursors only when every row they name exists here with the same id. */
export async function resolveResumeCursors(
  threadId: string,
  requested: ResumeCursors,
): Promise<ResolvedResume> {
  if (requested.canonicalAfter === 0 && requested.nativeAfter.size === 0) return FROM_ZERO;
  const [canonicalId, nativeIds] = await Promise.all([
    requested.canonicalAfter > 0 ? canonicalEventIdAt(threadId, requested.canonicalAfter) : null,
    nativeEventIdsAt(threadId, [...requested.nativeAfter].map(([runId, c]) => ({ runId, seq: c.seq }))),
  ]);
  if (requested.canonicalAfter > 0 && canonicalId !== requested.canonicalId) return { ...FROM_ZERO, reset: true };
  const nativeAfter = new Map<string, number>();
  for (const [runId, cursor] of requested.nativeAfter) {
    if (nativeIds.get(runId) !== cursor.eventId) return { ...FROM_ZERO, reset: true };
    nativeAfter.set(runId, cursor.seq);
  }
  return { canonicalAfter: requested.canonicalAfter, nativeAfter, reset: false };
}

/** The wire shape of the `resume` frame (the first frame of every connection). */
export function resumeFramePayload(threadId: string, resolved: ResolvedResume) {
  return {
    threadId,
    resume: {
      canonicalAfter: resolved.canonicalAfter,
      nativeAfter: Object.fromEntries(resolved.nativeAfter),
      reset: resolved.reset,
    },
  };
}
