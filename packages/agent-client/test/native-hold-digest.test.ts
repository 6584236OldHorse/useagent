import { describe, expect, test } from "bun:test";
import { nativeHoldDigest } from "../src/thread-events";

const held = [
  { eventId: "run::n0", seq: 0 },
  { eventId: "run::n1", seq: 1 },
  { eventId: "run::n2", seq: 2 },
];

describe("nativeHoldDigest", () => {
  test("the same set digests the same in any order, as 16 hex characters", () => {
    const digest = nativeHoldDigest(held);
    expect(digest).toMatch(/^[0-9a-f]{16}$/);
    expect(nativeHoldDigest([...held].reverse())).toBe(digest);
    expect(nativeHoldDigest([])).toMatch(/^[0-9a-f]{16}$/);
  });

  test("the two halves are not the same function of the text: their low bits disagree on some holds", () => {
    const holds = [held, held.slice(0, 1), [{ eventId: "run::g", seq: 2 }], [{ eventId: "x", seq: 7 }, { eventId: "y", seq: 8 }]];
    const lowBit = (hex: string) => Number.parseInt(hex.slice(-1), 16) & 1;
    const disagree = holds.filter((hold) => {
      const digest = nativeHoldDigest(hold);
      return lowBit(digest.slice(0, 8)) !== lowBit(digest.slice(8));
    });
    expect(disagree.length).toBeGreaterThan(0);
  });

  test("a frame added below the cursor, a frame missing, or a frame moved to another seq changes it", () => {
    const digest = nativeHoldDigest(held);
    expect(nativeHoldDigest([...held, { eventId: "run::late", seq: 1 }])).not.toBe(digest);
    expect(nativeHoldDigest(held.slice(0, 2))).not.toBe(digest);
    expect(nativeHoldDigest([held[0]!, held[1]!, { eventId: "run::n2", seq: 3 }])).not.toBe(digest);
    // The same count and seq total with another identity is still a different hold.
    expect(nativeHoldDigest([held[0]!, held[1]!, { eventId: "run::g", seq: 2 }])).not.toBe(digest);
  });
});
