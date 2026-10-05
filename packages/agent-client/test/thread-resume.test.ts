import { describe, expect, test } from "bun:test";
import { decodeFrame, THREAD_FRAME_TYPES, validateResume } from "../src/thread-events";

describe("resume frame", () => {
  test("is a listened-for frame type", () => {
    expect(THREAD_FRAME_TYPES).toContain("resume");
  });

  test("decodes the honoured cursor and the backend epoch", () => {
    const frame = decodeFrame("resume", JSON.stringify({ threadId: "t", resume: { canonicalAfter: 42, reset: false, epoch: "boot-1" } }));
    expect(frame).toEqual({ kind: "resume", resume: { canonicalAfter: 42, reset: false, epoch: "boot-1" } });
  });

  test("defaults every field to a from-zero replay with nothing to drop and no epoch", () => {
    expect(decodeFrame("resume", "{}")).toEqual({ kind: "resume", resume: { canonicalAfter: 0, reset: false, epoch: null } });
    expect(validateResume({ canonicalAfter: -1, reset: "yes", epoch: "" })).toEqual({ canonicalAfter: 0, reset: false, epoch: null });
    expect(validateResume("junk")).toEqual({ canonicalAfter: 0, reset: false, epoch: null });
  });

  test("a non-object body is malformed like every other frame", () => {
    expect(decodeFrame("resume", "[]")).toEqual({ kind: "malformed", type: "resume" });
  });
});
