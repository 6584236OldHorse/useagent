import { describe, expect, test } from "bun:test";
import {
  buildRuntimeThreadCreateCommand,
  buildRuntimeTurnStartCommand,
} from "./runtime-orchestration";

// The reasoning effort reaches the runtime as a model selection option. The
// option id is the engine seam: Codex reads `reasoningEffort` and forwards it as
// its app-server turn's effort, Claude Code reads `effort`; OpenCode has none.

describe("runtime model selection reasoning effort", () => {
  test("a Codex turn carries the effort under reasoningEffort, on the turn and the thread", () => {
    const ctx = { runId: "run-1", threadId: "thread-1", model: "gpt-5.6-luna", reasoningEffort: "xhigh" };
    expect(buildRuntimeTurnStartCommand(ctx, "codex", "go").modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-luna",
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    });
    expect(buildRuntimeThreadCreateCommand(ctx, "codex").modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-luna",
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    });
  });

  test("a Claude Code turn carries the effort under effort", () => {
    const ctx = { runId: "run-1", threadId: "thread-1", model: "claude-opus-5", reasoningEffort: "max" };
    expect(buildRuntimeTurnStartCommand(ctx, "claude", "go").modelSelection).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5",
      options: [{ id: "effort", value: "max" }],
    });
  });

  test("an OpenCode turn never carries an effort option, and no effort sends none", () => {
    const ctx = { runId: "run-1", threadId: "thread-1", model: "openai/gpt-5.6-luna", reasoningEffort: "high" };
    expect(buildRuntimeTurnStartCommand(ctx, "opencode", "go").modelSelection).toEqual({
      instanceId: "opencode",
      model: "openai/gpt-5.6-luna",
      options: [],
    });
    const plain = { runId: "run-1", threadId: "thread-1", model: "gpt-5.6-luna" };
    expect(buildRuntimeTurnStartCommand(plain, "codex", "go").modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-luna",
      options: [],
    });
  });
});
