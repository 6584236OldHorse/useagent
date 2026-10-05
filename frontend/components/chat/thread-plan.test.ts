import { describe, expect, test } from "bun:test";
import { latestThreadPlan } from "./thread-plan";
import type { ApiStep } from "./types";

const todowrite = (id: string, content: string, status: "pending" | "completed"): ApiStep => ({
  id,
  run_id: "run-1",
  idx: 1,
  kind: "command",
  label: "todowrite",
  chip: null,
  code_json: JSON.stringify({ tool: "todowrite", input: { todos: [{ id: `${id}-1`, content, status }] } }),
  created_at: "2030-01-01T00:00:00Z",
});

describe("latestThreadPlan", () => {
  test("the newest turn's latest canonical plan wins", () => {
    const plan = latestThreadPlan([
      { steps: [todowrite("old", "Old plan", "pending")], canonical: [] },
      {
        steps: [],
        canonical: [
          { kind: "plan.updated", seq: 1, entries: [{ id: "a", text: "Draft", status: "completed" }] },
          {
            kind: "plan.updated",
            seq: 3,
            entries: [
              { id: "a", text: "Draft", status: "completed" },
              { id: "b", text: "Ship", status: "in_progress" },
            ],
          },
          { kind: "plan.updated", seq: 2, entries: [{ id: "a", text: "Draft", status: "pending" }] },
        ],
      },
    ]);
    expect(plan?.map((entry) => `${entry.text}:${entry.status}`)).toEqual([
      "Draft:completed",
      "Ship:in_progress",
    ]);
  });

  test("without canonical plans the last todowrite step of the newest planning turn is the plan", () => {
    const plan = latestThreadPlan([
      { steps: [todowrite("s1", "First", "pending"), todowrite("s2", "Second", "completed")] },
      { steps: [] },
    ]);
    expect(plan).toEqual([{ id: "s2-1", text: "Second", status: "completed" }]);
  });

  test("a thread that never planned has no plan", () => {
    expect(latestThreadPlan([{ steps: [] }, { steps: [], canonical: [{ kind: "tool.started", seq: 1 }] }])).toBeNull();
  });
});
