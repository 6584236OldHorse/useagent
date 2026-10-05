// Framework-free thread SSE frame vocabulary + decoder. This is the wire contract
// the useAgent backend publishes on the thread-scoped SSE (`/api/runs/:root/thread-events`)
// and the pure decoder that turns a raw `(event, data)` frame into a typed union - with
// NO React, product store, or product parser dependency. The useAgent React hook keeps its
// own native-lane projection; the client library owns only the transport decode + the
// canonical lane (the provider-neutral render source).

import type { CanonicalAgentEvent } from "@useagent/agent-harness/canonical";

/** The `event:` names on the thread SSE. Kept in sync with the backend publisher. */
export const THREAD_FRAME_TYPES = [
  "snapshot",
  "run",
  "step",
  "delta",
  "native",
  "canonical",
  "canonical-complete",
  "done",
  "resume",
] as const;
export type ThreadFrameType = (typeof THREAD_FRAME_TYPES)[number];

/** A canonical event as delivered on the SSE: the provider-neutral event PLUS the two
 *  useAgent delivery fields the reducer needs - `deliverySeq` (a bigserial >= 1 that
 *  totally orders the run's canonical lane) and `revision` (>= 0; a higher revision of
 *  the same `eventId` supersedes). These are useAgent delivery metadata, not part of the
 *  provider-neutral vocabulary, so they live here rather than in @useagent/agent-harness. */
export type CanonicalThreadEvent = CanonicalAgentEvent & {
  readonly deliverySeq: number;
  readonly revision: number;
};

/** The completion record: a run's canonical projection is durable + trustworthy.
 *  `degraded` means the run sealed as complete-degraded: the projection is complete as
 *  recorded, but at least one provider frame was lost at capture (`lostFrames` counts
 *  them). A client trusts the lane exactly as when not degraded; it may tell the user
 *  part of the run's activity is missing. Both fields default when a backend omits them. */
export interface CanonicalCompleteFrame {
  readonly runId: string;
  readonly degraded: boolean;
  readonly lostFrames: number;
}

/** The first frame of every connection: whether the server honoured the client's
 *  canonical resume cursor. `reset` means it did not (another backend process, a
 *  restore, a replaced row): the replay that follows is from zero and the client
 *  must drop what it retained before applying it. `epoch` identifies the backend
 *  process; a cursor is only ever sent back with the epoch that delivered it. Every
 *  field defaults to a from-zero replay with nothing to drop, which is also what an
 *  older backend does. */
export interface ResumeFrame {
  readonly canonicalAfter: number;
  readonly reset: boolean;
  readonly epoch: string | null;
}

/** One native frame a client retained, as the pair the hold digest is built from. */
export interface NativeHoldEntry {
  readonly eventId: string;
  readonly seq: number;
}

/** A digest of what a client holds of one run's native lane: the set of (eventId, seq)
 *  pairs it retained, order-independent, so the server can tell in one comparison whether
 *  its own rows at or below the client's cursor are exactly that set. A frame committed
 *  below the cursor after the hold was taken changes it (a new id), and so does a revision
 *  that moved a frame to another seq. Two FNV-1a 32-bit passes over the sorted `eventId:seq`
 *  lines, 16 hex characters. Not a cryptographic hash: an accidental collision is a 2^-64
 *  event whose only consequence is one client missing a frame until its next connection. */
export function nativeHoldDigest(frames: Iterable<NativeHoldEntry>): string {
  const text = Array.from(frames, (frame) => `${frame.eventId}:${frame.seq}`).sort().join("\n");
  const fnv1a = (basis: number): string => {
    let hash = basis;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  };
  return fnv1a(0x811c9dc5) + fnv1a(0x050c5d1f);
}

/** A decoded thread frame. `native`/`run`/`step`/`delta`/`snapshot` carry raw product
 *  payloads the useAgent hook still projects natively; the client library validates +
 *  owns only the canonical lane. `unknown` is a forward-compatible catch-all: an
 *  unrecognized future frame is surfaced, never coerced into a known kind or fatal. */
export type DecodedFrame =
  | { kind: "canonical"; event: CanonicalThreadEvent }
  | { kind: "canonical-complete"; complete: CanonicalCompleteFrame }
  | { kind: "resume"; resume: ResumeFrame }
  | { kind: "raw"; type: Exclude<ThreadFrameType, "canonical" | "canonical-complete" | "resume">; payload: Record<string, unknown> }
  | { kind: "unknown"; type: string; payload: Record<string, unknown> }
  | { kind: "malformed"; type: string };

function isFiniteNumber(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}
function isNonEmptyString(s: unknown): s is string {
  return typeof s === "string" && s.length > 0;
}

/** Validate the canonical delivery envelope BEFORE it reaches the reducer: a missing
 *  eventId/deliverySeq/revision/kind would corrupt ordering (NaN sort) or dedupe. The
 *  optional `frameThreadId` (from the SSE frame) must match the event's thread. Returns
 *  the typed event or null (dropped, never misapplied). */
export function validateCanonicalThreadEvent(
  raw: unknown,
  frameThreadId?: unknown,
): CanonicalThreadEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (e.schemaVersion !== 1) return null;
  if (!isNonEmptyString(e.eventId)) return null;
  if (!isNonEmptyString(e.kind)) return null;
  if (!isNonEmptyString(e.runId) || !isNonEmptyString(e.threadId)) return null;
  if (!isFiniteNumber(e.seq)) return null;
  if (!isFiniteNumber(e.deliverySeq) || e.deliverySeq <= 0) return null; // bigserial >= 1
  if (!isFiniteNumber(e.revision) || e.revision < 0) return null;
  // The stream is thread-scoped server-side; a frame whose event names a different thread
  // than its envelope is malformed. Enforced only when the frame carries a non-empty
  // threadId (matches the product validator exactly, so decoding is behavior-identical).
  if (isNonEmptyString(frameThreadId) && frameThreadId !== e.threadId) return null;
  // identity, when present, must be an object (the reducer reads identity.native*).
  if (e.identity !== undefined && (typeof e.identity !== "object" || e.identity === null)) return null;
  return raw as CanonicalThreadEvent;
}

/** Validate a `canonical-complete` frame's `complete` record. Matches the product
 *  validator exactly: a non-empty runId, and if BOTH the frame threadId and the record's
 *  own threadId are present they must agree (never trust a cross-thread completion).
 *  Returns the typed record or null (dropped). */
export function validateCanonicalComplete(
  raw: unknown,
  frameThreadId?: unknown,
): CanonicalCompleteFrame | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  if (!isNonEmptyString(c.runId)) return null;
  if (isNonEmptyString(frameThreadId) && isNonEmptyString(c.threadId) && c.threadId !== frameThreadId) return null;
  return {
    runId: c.runId,
    degraded: c.degraded === true,
    lostFrames: isFiniteNumber(c.lostFrames) && c.lostFrames > 0 ? c.lostFrames : 0,
  };
}

/** Decode ONE raw SSE frame `(event, data)` into a typed {@link DecodedFrame}. Pure:
 *  no store, no product parser, no React. Malformed JSON, a non-object payload, or an
 *  invalid canonical envelope yields a `malformed`/dropped frame rather than throwing -
 *  a bad frame never tears down the connection. Unknown future `event:` names surface as
 *  `unknown`. */
/** Lenient by design: a missing or junk `resume` body is a from-zero replay. */
export function validateResume(raw: unknown): ResumeFrame {
  const obj = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    canonicalAfter: isFiniteNumber(obj.canonicalAfter) && obj.canonicalAfter >= 0 ? obj.canonicalAfter : 0,
    reset: obj.reset === true,
    epoch: isNonEmptyString(obj.epoch) ? obj.epoch : null,
  };
}

export function decodeFrame(event: string, data: string): DecodedFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { kind: "malformed", type: event };
  }
  // A well-formed thread frame is ALWAYS a JSON object. A non-object (null, number,
  // string, boolean, or array) is malformed and must never be dereferenced.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "malformed", type: event };
  }
  const obj = parsed as Record<string, unknown>;
  if (event === "canonical") {
    const ev = validateCanonicalThreadEvent(obj.event, obj.threadId);
    return ev ? { kind: "canonical", event: ev } : { kind: "malformed", type: event };
  }
  if (event === "canonical-complete") {
    const complete = validateCanonicalComplete(obj.complete, obj.threadId);
    return complete ? { kind: "canonical-complete", complete } : { kind: "malformed", type: event };
  }
  if (event === "resume") return { kind: "resume", resume: validateResume(obj.resume) };
  if ((THREAD_FRAME_TYPES as readonly string[]).includes(event)) {
    return { kind: "raw", type: event as Exclude<ThreadFrameType, "canonical" | "canonical-complete" | "resume">, payload: obj };
  }
  return { kind: "unknown", type: event, payload: obj };
}
