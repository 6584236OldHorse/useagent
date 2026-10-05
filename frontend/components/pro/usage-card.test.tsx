import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { contextSegments, minutesLimit, spendLimit, UsageCard } from "./usage-card";

const T3 = { used: 18_357, cached: 17_152, window: 258_400, input: 18_336, output: 21, reasoning: 0, cacheWrite: 0 };
const PI = { used: 42_000, cached: 30_000, window: 1_000_000, input: 11_000, output: 1_000, reasoning: 0, cacheWrite: 0 };
const OPENCODE = { used: 92_400, cached: 61_000, window: null, input: 30_000, output: 1_400, reasoning: 0, cacheWrite: 180 };

describe("usage card figures", () => {
  test("segments are the buckets the frame carried, unreported ones left out", () => {
    expect(contextSegments(T3)).toEqual([
      { label: "Fresh input", tokens: 18_336 },
      { label: "Cached input", tokens: 17_152 },
      { label: "Output", tokens: 21 },
    ]);
    expect(contextSegments(OPENCODE).map((s) => s.label)).toEqual([
      "Fresh input",
      "Cached input",
      "Output",
      "Cache write",
    ]);
    expect(contextSegments({ used: 500, cached: 0, window: null })).toEqual([]);
  });

  test("the minutes row reads x of y with a share while a cap is set, x alone without", () => {
    expect(minutesLimit({ used: 12, cap: 600 })).toEqual({
      label: "Sandbox minutes",
      detail: "12 of 600 min",
      used: 0.02,
    });
    expect(minutesLimit({ used: 12, cap: null })).toEqual({ label: "Sandbox minutes", detail: "12 min" });
  });

  test("the spend row reads dollars of allowance with a share while one is set, dollars alone without", () => {
    expect(spendLimit({ spent: 12.34, allowance: 100, runs: 3 })).toEqual({
      label: "Spend",
      detail: "$12.34 of $100",
      used: 0.1234,
    });
    expect(spendLimit({ spent: 5, allowance: null, runs: 1 })).toEqual({ label: "Spend", detail: "$5" });
  });
});

describe("UsageCard", () => {
  test("a runtime that reports its window: used / window, the percent the ring shows, the bar", () => {
    const html = renderToStaticMarkup(<UsageCard context={T3} minutes={{ used: 12, cap: 600 }} />);
    expect(html).toContain("Context window");
    expect(html).toContain("18.4k / 258.4k");
    expect(html).toContain("(7%)");
    expect(html).toContain("bg-chart-track");
    expect(html).toContain('title="Fresh input · 18.3k"');
    expect(html).toContain(">Usage limits<");
    expect(html).toContain("Sandbox minutes");
    expect(html).toContain("12 of 600 min");
    expect(html).toContain(">2%<");
    expect(html).not.toContain("Resets");
    expect(html).not.toContain("Plan usage limits");
  });

  test("Pi reports its window the same way", () => {
    const html = renderToStaticMarkup(<UsageCard context={PI} minutes={{ used: 0, cap: 600 }} />);
    expect(html).toContain("42k / 1M");
    expect(html).toContain("(4%)");
  });

  test("OpenCode reports no window: the token readout only, no bar, no invented max", () => {
    const html = renderToStaticMarkup(<UsageCard context={OPENCODE} minutes={{ used: 12, cap: 600 }} />);
    expect(html).toContain("92.4k tok");
    expect(html).not.toContain(" / ");
    expect(html).not.toContain("%)");
    // The context bar is absent; the minutes row still draws its own bar.
    expect(html.match(/bg-chart-track/g)).toHaveLength(1);
    expect(html).not.toContain("Free space");
  });

  test("with the cap off the minutes row shows the figure without a bar or a percent", () => {
    const html = renderToStaticMarkup(<UsageCard context={T3} minutes={{ used: 12, cap: null }} />);
    expect(html).toContain(">12 min<");
    // Only the context bar remains.
    expect(html.match(/bg-chart-track/g)).toHaveLength(1);
    expect(html).not.toContain(">2%<");
  });

  test("the spend row joins when the tab holds a snapshot; Compact stays the action", () => {
    const html = renderToStaticMarkup(
      <UsageCard
        context={T3}
        minutes={{ used: 12, cap: 600 }}
        spend={{ spent: 12.34, allowance: 100, runs: 3 }}
        onCompact={() => {}}
      />,
    );
    expect(html).toContain(">Spend<");
    expect(html).toContain("$12.34 of $100");
    expect(html).toContain(">12%<");
    expect(html).toContain("Compact now");
    const capOff = renderToStaticMarkup(
      <UsageCard context={T3} minutes={null} spend={{ spent: 5, allowance: null, runs: 1 }} />,
    );
    expect(capOff).toContain(">$5<");
    expect(capOff).not.toContain("Sandbox minutes");
  });
});
