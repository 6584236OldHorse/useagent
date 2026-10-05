import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentLimitsCard } from "./agent-limits-card";
import { ComposerStatusBar, contextPercent, formatTokens } from "./composer-status-bar";

describe("ComposerStatusBar", () => {
  test("shows the percent when the window is known and the token count otherwise", () => {
    const withWindow = renderToStaticMarkup(
      <ComposerStatusBar
        branch="main"
        project="useagent"
        agent="Codex"
        context={{ used: 570_000, cached: 400_000, window: 1_000_000 }}
      />,
    );
    expect(withWindow).toContain("57%");
    expect(withWindow).toContain("main");
    expect(withWindow).toContain("useagent");
    const noWindow = renderToStaticMarkup(
      <ComposerStatusBar agent="Codex" context={{ used: 12_300, cached: 0, window: null }} />,
    );
    expect(noWindow).toContain("12.3k tok");
    expect(renderToStaticMarkup(<ComposerStatusBar agent="Codex" context={null} />)).not.toContain(
      "tok",
    );
  });

  test("shows the spend chip only while a cap is set, red once it is reached", () => {
    const under = renderToStaticMarkup(
      <ComposerStatusBar agent="Codex" context={null} spend={{ spent: 12.345, allowance: 100, runs: 3 }} />,
    );
    expect(under).toContain("Spent $12.35 of $100");
    expect(under).not.toContain("text-text-error-primary");
    const capped = renderToStaticMarkup(
      <ComposerStatusBar agent="Codex" context={null} spend={{ spent: 100.5, allowance: 100, runs: 9 }} />,
    );
    expect(capped).toContain("Spent $100.50 of $100");
    expect(capped).toContain("text-text-error-primary");
    const uncapped = renderToStaticMarkup(
      <ComposerStatusBar agent="Codex" context={null} spend={{ spent: 4, allowance: null, runs: 1 }} />,
    );
    expect(uncapped).not.toContain("Spent");
  });

  test("the tray hangs under the card's bottom edge, inset on both sides, and names where the run executes", () => {
    const html = renderToStaticMarkup(
      <ComposerStatusBar
        run={{ sandbox_id: "sbx-1", sandbox_provider: "daytona" }}
        agent="Codex"
        context={{ used: 92_400, cached: 61_000, window: 200_000 }}
      />,
    );
    const tab = html.match(/<div[^>]*class="[^"]*"/)?.[0] ?? "";
    expect(tab).toContain("mx-7");
    expect(tab).toContain("rounded-b-2xl");
    expect(tab).not.toContain("rounded-t-2xl");
    expect(tab).toContain("bg-composer-panel-tab-background");
    // The tab reads Cloud for a hosted sandbox, and a member is never told the vendor.
    expect(html).toContain(">Cloud<");
    expect(html).not.toContain("Daytona");
    expect(html).toContain('title="Runs in the cloud"');
    // Absence stays in the Details rail; the tab never prints a placeholder.
    expect(html).not.toContain("No repository");
    expect(html).not.toContain("Default branch");
  });

  test("formats tokens and clamps the percent", () => {
    expect([formatTokens(314), formatTokens(96_000), formatTokens(1_250_000)]).toEqual([
      "314",
      "96k",
      "1.3M",
    ]);
    expect(contextPercent({ used: 2, cached: 0, window: 1 })).toBe(100);
    expect(contextPercent({ used: 2, cached: 0, window: null })).toBeNull();
  });
});

describe("AgentLimitsCard", () => {
  test("renders the plan limits alone when no context is given", () => {
    const html = renderToStaticMarkup(
      <AgentLimitsCard
        plan="ChatGPT Plus"
        limits={[{ label: "5-hour limit", used: 0.38, resets: "Resets in 2 hr" }]}
      />,
    );
    expect(html).toContain("5-hour limit");
    expect(html).toContain("38%");
    expect(html).not.toContain("Context window");
    const withContext = renderToStaticMarkup(
      <AgentLimitsCard
        context={{ max: 1000, segments: [{ label: "Messages", tokens: 250 }] }}
        limits={[]}
      />,
    );
    expect(withContext).toContain("Context window");
    expect(withContext).toContain("(25%)");
  });
});

describe("AgentLimitsCard local changes", () => {
  test("a null window shows the readout alone, and a capless limit shows no bar or percent", () => {
    const html = renderToStaticMarkup(
      <AgentLimitsCard
        context={{ max: null, used: 900, segments: [{ label: "Fresh input", tokens: 600 }] }}
        limitsTitle="Usage limits"
        plan=""
        limits={[{ label: "Sandbox minutes", detail: "12 min" }]}
      />,
    );
    expect(html).toContain("900 tok");
    expect(html).not.toContain(" / ");
    expect(html).not.toContain("bg-chart-track");
    expect(html).toContain(">Usage limits<");
    expect(html).toContain(">12 min<");
    expect(html).not.toContain("%");
    // The header follows the given used figure, not the segment sum, so it matches the ring.
    const windowed = renderToStaticMarkup(
      <AgentLimitsCard context={{ max: 1000, used: 900, segments: [{ label: "Fresh input", tokens: 600 }] }} limits={[]} />,
    );
    expect(windowed).toContain("900 / 1k");
    expect(windowed).toContain("(90%)");
    // No limit rows yet (still loading, or none to show): no heading either.
    expect(windowed).not.toContain("usage limits");
    // A window reported as 0 is no window, and a used figure past the window reads 100%.
    const zero = renderToStaticMarkup(
      <AgentLimitsCard context={{ max: 0, used: 900, segments: [{ label: "Fresh input", tokens: 900 }] }} limits={[]} />,
    );
    expect(zero).toContain("900 tok");
    expect(zero).not.toContain("%)");
    const over = renderToStaticMarkup(
      <AgentLimitsCard context={{ max: 1000, used: 1100, segments: [{ label: "Fresh input", tokens: 1100 }] }} limits={[]} />,
    );
    expect(over).toContain("(100%)");
  });
});
