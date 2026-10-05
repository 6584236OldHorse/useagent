import { describe, expect, test } from "bun:test";
import type { NativeFrame } from "./native-events";
import { threadUsage } from "./thread-usage";
import type { ApiStep } from "./types";

function frame(
  id: string,
  seq: number,
  payload: Record<string, unknown>,
  native: NativeFrame["native"] = {},
): NativeFrame {
  return {
    schemaVersion: 1,
    eventId: id,
    seq,
    provider: "opencode",
    eventType: "part.step-finish",
    native,
    payload,
  } as NativeFrame;
}

function step(id: string, idx: number, code: Record<string, unknown>): ApiStep {
  return {
    id,
    run_id: "run-1",
    idx,
    kind: "command",
    label: "Execute",
    chip: null,
    code_json: JSON.stringify(code),
    created_at: "2030-01-01T00:00:00Z",
  };
}

const STEPS: ApiStep[] = [
  step("s1", 1, { tool: "bash", input: { command: "bun test" }, output: "ok" }),
  step("s2", 2, { tool: "read", input: { file_path: "src/a.ts" }, output: "export {}" }),
  step("s3", 3, { tool: "todowrite", input: { todos: [{ content: "Plan", status: "pending" }] } }),
];

describe("threadUsage", () => {
  test("sums the parent session's step-finish tokens and counts the tool calls", () => {
    const usage = threadUsage([
      {
        run: { child_session: false },
        status: "completed",
        steps: STEPS,
        native: {
          nativeFrames: [
            frame("f1", 1, { tokens: { input: 100, output: 20, cache: { read: 50, write: 10 } } }),
            frame("f2", 2, { tokens: { input: 200, output: 30, reasoning: 5 } }),
            // A child session's call is the child's own usage.
            frame("f3", 3, { tokens: { input: 999, output: 999 } }, { sessionId: "ses_child" }),
            // A frame without tokens reports nothing.
            frame("f4", 4, { contextWindow: 200_000 }),
          ],
          childSessionIds: new Set(["ses_child"]),
        },
      },
    ]);
    expect(usage).toEqual({ inputTokens: 360, outputTokens: 55, toolCalls: 2 });
  });

  test("a thread whose engine reports no tokens still counts its tool calls", () => {
    expect(threadUsage([{ run: {}, status: "completed", steps: STEPS }])).toEqual({
      inputTokens: null,
      outputTokens: null,
      toolCalls: 2,
    });
  });

  test("a gateway child session's turn never feeds the parent's tokens", () => {
    const usage = threadUsage([
      {
        run: { child_session: true },
        status: "completed",
        steps: [],
        native: {
          nativeFrames: [frame("f1", 1, { tokens: { input: 40, output: 4 } })],
          childSessionIds: new Set<string>(),
        },
      },
    ]);
    expect(usage.inputTokens).toBeNull();
  });
});
