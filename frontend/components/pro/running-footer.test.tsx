import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RunningFooter } from "./running-footer";
import type { RunningStatus } from "./running-phase";

const status: RunningStatus = {
  phase: "working",
  label: "Working",
  sentence: "bun run typecheck",
  toolCalls: 3,
  agentsRunning: 1,
  agentsDone: 2,
};

test("renders the phase chip, the current step, the elapsed time and the Stop control", () => {
  const startedAt = new Date(Date.now() - 65_000).toISOString();
  const html = renderToStaticMarkup(
    <RunningFooter status={status} model="Claude Sonnet 5" startedAt={startedAt} onStop={() => {}} />,
  );
  expect(html).toContain('data-session-ui="running-footer"');
  expect(html).toContain('role="status"');
  expect(html).toContain(">Working<");
  expect(html).toContain("bun run typecheck");
  expect(html).toContain("1m 5s");
  expect(html).toContain("font-mono");
  expect(html).toContain('aria-label="Stop this run"');
  // The chip is a real button with a caret that opens the details popover.
  expect(html).toContain('aria-label="Working. Run details"');
  expect(html).toContain("ai-loading-pixel");
});

test("stopping disables the control and says so; no elapsed without a start time", () => {
  const html = renderToStaticMarkup(<RunningFooter status={status} model="m" onStop={() => {}} stopping />);
  expect(html).toContain('aria-label="Stopping this run"');
  expect(html).toContain("disabled");
  expect(html).not.toContain("font-mono");
});

test("a delegating phase names the agent in the chip", () => {
  const html = renderToStaticMarkup(
    <RunningFooter
      status={{ ...status, phase: "delegating", label: "Delegating Verify checkout", sentence: "Running the suite" }}
      model="m"
    />,
  );
  expect(html).toContain(">Delegating Verify checkout<");
  expect(html).toContain("Running the suite");
  expect(html).not.toContain("Stop this run");
});
