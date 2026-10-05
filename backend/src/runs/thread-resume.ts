// Resume cursors for the thread stream. A browser that already holds part of a
// thread (a retained store, or a reconnect) tells the server what it has, and the
// server replays only what is newer. Cursors this backend cannot prove (ahead of the
// durable maximum: a rollback, a different database) are refused as a whole: the
// replay is from zero and the `resume` frame says so, so the client drops what it
// retained before applying the replay. Absent or malformed cursors mean from zero,
// exactly what an older client gets.
import { maxCanonicalDeliverySeq } from "./canonical-events";
import { maxNativeSeqByRun } from "./native-events";

export interface ResumeCursors {
  /** Newest canonical delivery seq the client holds (0: none). */
  readonly canonicalAfter: number;
  /** Newest native seq the client holds, per run (absent: none for that run). */
  readonly nativeAfter: ReadonlyMap<string, number>;
}

export interface ResolvedResume extends ResumeCursors {
  /** The request's cursors were ahead of this backend's durable state; replay is from zero. */
  readonly reset: boolean;
}

export const FROM_ZERO: ResolvedResume = { canonicalAfter: 0, nativeAfter: new Map(), reset: false };

function nonNegativeInt(value: string | undefined): number | null {
  return value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : null;
}

/** `canonicalAfter=<deliverySeq>&nativeAfter=<runId>:<seq>,<runId>:<seq>`. Anything
 *  malformed reads as absent, never as an error: a bad cursor costs a full replay. */
export function parseResumeCursors(
  canonicalAfter: string | undefined,
  nativeAfter: string | undefined,
): ResumeCursors {
  const native = new Map<string, number>();
  for (const part of (nativeAfter ?? "").split(",")) {
    const at = part.lastIndexOf(":");
    if (at <= 0) continue;
    const seq = nonNegativeInt(part.slice(at + 1));
    if (seq !== null) native.set(part.slice(0, at), seq);
  }
  return { canonicalAfter: nonNegativeInt(canonicalAfter) ?? 0, nativeAfter: native };
}

/** Honour only cursors at or below the durable maximum. One cursor ahead of it means
 *  the client holds state this database never produced, so nothing is honoured. */
export async function resolveResumeCursors(
  threadId: string,
  requested: ResumeCursors,
): Promise<ResolvedResume> {
  if (requested.canonicalAfter === 0 && requested.nativeAfter.size === 0) return FROM_ZERO;
  const [canonicalMax, nativeMax] = await Promise.all([
    maxCanonicalDeliverySeq(threadId),
    maxNativeSeqByRun(threadId),
  ]);
  if (requested.canonicalAfter > canonicalMax) return { ...FROM_ZERO, reset: true };
  for (const [runId, seq] of requested.nativeAfter) {
    const known = nativeMax.get(runId);
    if (known === undefined || seq > known) return { ...FROM_ZERO, reset: true };
  }
  return { ...requested, reset: false };
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
