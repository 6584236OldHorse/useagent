import { describe, expect, test } from "bun:test";
import { limitRows } from "./codex-limits-card";

describe("limitRows", () => {
  const now = new Date("2026-09-13T12:00:00Z");

  test("names the windows by duration and phrases the reset", () => {
    const rows = limitRows(
      {
        planType: "plus",
        primary: {
          usedPercent: 38,
          windowDurationMins: 300,
          resetsAt: Math.floor(now.getTime() / 1000) + 166 * 60,
        },
        secondary: {
          usedPercent: 3,
          windowDurationMins: 10_080,
          resetsAt: Math.floor(now.getTime() / 1000) + 3 * 24 * 3600,
        },
      },
      now,
    );
    expect(rows.map((r) => [r.label, r.used, r.resets.startsWith("Resets")])).toEqual([
      ["5-hour limit", 0.38, true],
      ["Weekly limit", 0.03, true],
    ]);
    expect(rows[0]?.resets).toBe("Resets in 2 hr 46 min");
  });

  test("skips windows the provider did not report and clamps the share", () => {
    const rows = limitRows(
      {
        planType: null,
        primary: { usedPercent: 140, windowDurationMins: null, resetsAt: null },
        secondary: null,
      },
      now,
    );
    expect(rows).toEqual([{ label: "Session limit", used: 1, resets: "" }]);
  });
});
