import { describe, expect, test } from "bun:test";
import { reasoningEffortSupport, resolveReasoningEffort } from "./reasoning-effort";

describe("reasoning effort support", () => {
  test("Codex offers the policy set until the native catalog knows the model", () => {
    expect(reasoningEffortSupport("codex")).toEqual({
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "medium",
    });
    expect(
      reasoningEffortSupport("codex", {
        supportedReasoningEfforts: ["low", "high", "max"],
        defaultReasoningEffort: "high",
      }),
    ).toEqual({ efforts: ["low", "high", "max"], defaultEffort: "high" });
    // A native row without efforts falls back to the policy set, keeping its default.
    expect(reasoningEffortSupport("codex", { supportedReasoningEfforts: [] }).efforts).toEqual([
      "low", "medium", "high", "xhigh",
    ]);
  });

  test("Claude Code offers the agent's levels; the other engines offer none", () => {
    expect(reasoningEffortSupport("claude")).toEqual({
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "high",
    });
    for (const engine of ["opencode", "pi", "chat", "mock"] as const) {
      expect(reasoningEffortSupport(engine)).toEqual({ efforts: [], defaultEffort: null });
    }
  });
});

describe("resolving a run's reasoning effort", () => {
  const codex = reasoningEffortSupport("codex");

  test("an explicit supported value wins over the parent", () => {
    expect(resolveReasoningEffort("xhigh", codex, "low")).toEqual({ ok: true, value: "xhigh" });
    expect(resolveReasoningEffort(" high ", codex, null)).toEqual({ ok: true, value: "high" });
  });

  test("no value inherits the parent while the catalog still offers it", () => {
    expect(resolveReasoningEffort(undefined, codex, "high")).toEqual({ ok: true, value: "high" });
    expect(resolveReasoningEffort(null, codex, null)).toEqual({ ok: true, value: null });
    expect(resolveReasoningEffort("", codex, "ultra")).toEqual({ ok: true, value: null });
  });

  test("a value the engine does not offer is a client error, not a fallback", () => {
    expect(resolveReasoningEffort("ultra", codex, null)).toEqual({
      ok: false,
      error: "reasoning_effort_invalid",
      efforts: ["low", "medium", "high", "xhigh"],
    });
    expect(resolveReasoningEffort(3, codex, null)).toMatchObject({ ok: false, error: "reasoning_effort_invalid" });
    expect(resolveReasoningEffort("high", reasoningEffortSupport("opencode"), null)).toEqual({
      ok: false,
      error: "reasoning_effort_not_supported",
      efforts: [],
    });
  });
});
