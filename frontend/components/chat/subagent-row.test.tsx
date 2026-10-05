import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { type CanonicalChildEventLike, deriveChildrenView } from "./canonical-children";
import { SubagentRow } from "./subagent-row";
import type { ApiStep } from "./types";

const T0 = Date.parse("2030-01-01T00:00:00Z");

function step(
  id: string,
  idx: number,
  kind: ApiStep["kind"],
  label: string,
  chip: string | null,
  code: Record<string, unknown>,
): ApiStep {
  return {
    id,
    run_id: "run-1",
    idx,
    kind,
    label,
    chip,
    code_json: JSON.stringify(code),
    created_at: new Date(T0 + idx * 1000).toISOString(),
  };
}

/** The parent's spawn step, two steps the child ran in its own session, and one
 *  the parent ran itself (never the child's). */
const STEPS: ApiStep[] = [
  step("spawn", 0, "task", "Subagent - verify checkout", "subagent", {
    tool: "task",
    input: { description: "Verify checkout" },
    native: { sessionID: "ses_root", callID: "call-1", childSessionID: "ses_child" },
  }),
  step("child-run", 1, "command", "bun test checkout", null, {
    tool: "bash",
    input: { command: "bun test checkout" },
    output: "12 pass",
    exit_code: 0,
    duration_ms: 4_300,
    native: { sessionID: "ses_child" },
  }),
  step("child-read", 2, "command", "read checkout.ts", null, {
    tool: "read",
    input: { file_path: "src/checkout.ts" },
    output: "export {}",
    native: { sessionID: "ses_child" },
  }),
  step("parent-run", 3, "command", "git status", null, {
    tool: "bash",
    input: { command: "git status" },
    output: "clean",
    native: { sessionID: "ses_root" },
  }),
];

const LONG_RESULT = "Checkout verified end to end. ".repeat(12).trim();

function events(over: { running?: boolean; result?: string } = {}): CanonicalChildEventLike[] {
  const started: CanonicalChildEventLike = {
    kind: "child.started",
    seq: 1,
    ts: T0,
    childId: "ses_child",
    launchToolCallId: "call-1",
    title: "Verify checkout",
    state: {
      status: "running",
      summary: "Running the suite",
      role: "verifier",
      model: "gpt-5.6-luna",
      usage: { totalTokens: 41_200 },
    },
  };
  if (over.running) return [started];
  return [
    started,
    {
      kind: "child.completed",
      seq: 2,
      ts: T0 + 72_400,
      childId: "ses_child",
      status: "ok",
      result: over.result ?? LONG_RESULT,
      state: { usage: { totalTokens: 41_200, durationMs: 72_400 } },
    },
  ];
}

function render(
  over: { running?: boolean; result?: string } = {},
  props: { defaultOpen?: boolean; steps?: readonly ApiStep[] } = {},
): string {
  const steps = props.steps ?? STEPS;
  const view = deriveChildrenView(steps, [], events(over));
  const card = view.cards[0];
  if (!card) throw new Error("no card derived");
  const fidelity = card.aliases
    .map((alias) => view.fidelity.get(alias))
    .find((match) => match !== undefined);
  return renderToStaticMarkup(
    <ul>
      <SubagentRow
        card={card}
        fidelity={fidelity}
        steps={steps.filter((item) => view.ownerByStep.get(item.id) === card.id)}
        runLive={Boolean(over.running)}
        defaultOpen={props.defaultOpen}
      />
    </ul>,
  );
}

describe("subagent row", () => {
  test("a settled child folds to one line: its name, its role and how long it ran", () => {
    const html = render();
    expect(html).toContain('data-status="completed"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Verify checkout");
    expect(html).toContain(">verifier<");
    expect(html).toContain(">1m 12.4s<");
    // Nothing of the open state reaches the DOM: no rows, no summary, no model line.
    expect(html).not.toContain('data-testid="trace-row"');
    expect(html).not.toContain('data-testid="subagent-summary"');
    expect(html).not.toContain("gpt-5.6-luna");
    expect(html).not.toContain("Checkout verified");
  });

  test("opened, the child's own tool rows carry their durations and its result sits in a Summary card behind More", () => {
    const html = render({}, { defaultOpen: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("trace-guide");
    // Only the steps attributed to this child, in the parent's row grammar.
    expect(html.match(/data-testid="trace-row"/g)).toHaveLength(2);
    expect(html).toContain(">Run<");
    expect(html).toContain(">bun test checkout<");
    expect(html).toContain(">Read<");
    expect(html).not.toContain("git status");
    expect(html).toContain('data-testid="trace-row-duration"');
    expect(html).toContain(">4.3s<");
    expect(html).toContain("gpt-5.6-luna · 41.2k tok");
    expect(html).toContain('data-testid="subagent-summary"');
    expect(html).toContain(">Summary<");
    expect(html).toContain("Checkout verified end to end.");
    expect(html).toContain("line-clamp-3");
    expect(html).toContain(">More<");
  });

  test("a short result needs no More", () => {
    const html = render({ result: "Suite green." }, { defaultOpen: true });
    expect(html).toContain("Suite green.");
    expect(html).not.toContain(">More<");
    expect(html).not.toContain("line-clamp-3");
  });

  test("a working child starts open on its rows, or on its progress before any row lands", () => {
    const html = render({ running: true });
    expect(html).toContain('data-status="running"');
    expect(html).toContain('aria-expanded="true"');
    expect(html.match(/data-testid="trace-row"/g)).toHaveLength(2);
    expect(html).not.toContain('data-testid="subagent-summary"');
    const bare = render({ running: true }, { steps: STEPS.slice(0, 1) });
    expect(bare).not.toContain('data-testid="trace-row"');
    expect(bare).toContain("Running the suite");
  });
});

describe("subagent row residuals", () => {
  test("a result of exactly the fold length still folds behind More", () => {
    const html = render({ result: "x".repeat(240) }, { defaultOpen: true });
    expect(html).toContain("line-clamp-3");
    expect(html).toContain(">More<");
  });

  test("a running spawn with no frame and no steps yet says Working", () => {
    const view = deriveChildrenView(STEPS.slice(0, 1), [], []);
    const card = view.cards[0];
    if (!card) throw new Error("no legacy card derived");
    const html = renderToStaticMarkup(
      <ul>
        <SubagentRow card={card} fidelity={undefined} steps={[]} runLive />
      </ul>,
    );
    expect(html).toContain('data-status="running"');
    expect(html).toContain(">Working<");
  });
});
