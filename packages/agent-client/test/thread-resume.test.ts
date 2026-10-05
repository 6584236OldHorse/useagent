import { describe, expect, test } from "bun:test";
import { decodeFrame, THREAD_FRAME_TYPES, validateResume } from "../src/thread-events";

describe("resume frame", () => {
  test("is a listened-for frame type", () => {
    expect(THREAD_FRAME_TYPES).toContain("resume");
  });

  test("decodes the honoured cursors", () => {
    const frame = decodeFrame("resume", JSON.stringify({ threadId: "t", resume: { canonicalAfter: 42, nativeAfter: { r1: 3, r2: 0 }, reset: false } }));
    expect(frame).toEqual({ kind: "resume", resume: { canonicalAfter: 42, nativeAfter: { r1: 3, r2: 0 }, reset: false } });
  });

  test("defaults every field to a from-zero replay with nothing to drop", () => {
    expect(decodeFrame("resume", "{}")).toEqual({ kind: "resume", resume: { canonicalAfter: 0, nativeAfter: {}, reset: false } });
    expect(validateResume({ canonicalAfter: -1, nativeAfter: { r1: "3", r2: -2, r3: 5 }, reset: "yes" })).toEqual({ canonicalAfter: 0, nativeAfter: { r3: 5 }, reset: false });
    expect(validateResume("junk")).toEqual({ canonicalAfter: 0, nativeAfter: {}, reset: false });
  });

  test("a non-object body is malformed like every other frame", () => {
    expect(decodeFrame("resume", "[]")).toEqual({ kind: "malformed", type: "resume" });
  });
});
