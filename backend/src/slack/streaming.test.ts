/**
 * Pure streaming-grammar tests: no I/O, fixtures only. The chunk shapes here ARE
 * the documented wire contract of chat.startStream/appendStream/stopStream
 * (flat task_update with id/title/status, plan_update with title, markdown_text
 * with text) - a drift in these shapes is exactly the bug that made live Slack
 * reject every stream and silently fall back to the plain card.
 */
import { describe, expect, test } from "bun:test";
import {
  composeStreamClosing,
  createNarrationBuffer,
  directMessageChannel,
  markdownChunksFor,
  openingStreamChunks,
  planUpdateFromStep,
  statusTextForStep,
  stepProgressChunks,
  taskSourcesField,
  taskUpdateChunk,
  TERMINAL_CARD_BUDGET,
  terminalTaskChunks,
  toolTaskChunk,
} from "./streaming";

/** A durable step row as the bus carries it; code_json is the T3 projection. */
function step(input: {
  id?: string;
  kind?: string;
  label: string;
  chip?: string | null;
  code?: Record<string, unknown> | null;
}) {
  return {
    id: input.id ?? "s1",
    kind: input.kind ?? "command",
    label: input.label,
    chip: input.chip ?? null,
    code_json: input.code === null ? null : JSON.stringify(input.code ?? {}),
  };
}

describe("wire chunk shapes (documented contract)", () => {
  test("task_update is FLAT: id/title/status at the top level, no nesting", () => {
    const chunk = taskUpdateChunk({ id: "step_1", title: "Cloning repo", status: "in_progress" });
    expect(chunk).toEqual({
      type: "task_update",
      id: "step_1",
      title: "Cloning repo",
      status: "in_progress",
    });
    expect("task" in chunk).toBe(false);
    expect("task_id" in chunk).toBe(false);
  });

  test("markdown chunks carry `text` (not `markdown_text`) and never mutate content", () => {
    const [chunk] = markdownChunksFor("Hello **world**");
    expect(chunk).toEqual({ type: "markdown_text", text: "Hello **world**" });
  });

  test("markdownChunksFor splits long text exactly, preserving every char", () => {
    const text = "x".repeat(25_000);
    const chunks = markdownChunksFor(text);
    expect(chunks.length).toBe(3);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    expect(markdownChunksFor("")).toEqual([]);
  });

  test("task titles cap under Slack's 256-char limit", () => {
    const chunk = taskUpdateChunk({ id: "t", title: "y".repeat(400), status: "complete" });
    expect(chunk.title.length).toBeLessThanOrEqual(250);
    expect(chunk.title.endsWith("…")).toBe(true);
  });

  test("the opening is one spinning root task - no throwaway markdown in the body", () => {
    const chunks = openingStreamChunks("Build the thing");
    expect(chunks).toEqual([
      { type: "task_update", id: "run", title: "Build the thing", status: "in_progress" },
    ]);
  });
});

describe("toolTaskChunk (one card per tool call, chatter never)", () => {
  test("runtime chatter and the done marker are not cards", () => {
    expect(toolTaskChunk(step({ kind: "task", label: "Preparing context and runtime…", chip: "boot", code: { phase: "preparing" } }))).toBeNull();
    expect(toolTaskChunk(step({ kind: "task", label: "Waiting for provider activity…", chip: "runtime:claude", code: null }))).toBeNull();
    expect(
      toolTaskChunk(step({ kind: "task", label: "Context window updated", chip: "thread.context.updated", code: { source: "t3", activityKind: "thread.context.updated" } })),
    ).toBeNull();
    expect(toolTaskChunk(step({ kind: "done", label: "Done", code: null }))).toBeNull();
  });

  test("plan rows travel as plan_update, never as a card", () => {
    expect(
      toolTaskChunk(step({ kind: "command", label: "Update plan", chip: "plan", code: { source: "t3", activityKind: "turn.plan.updated", tool: "todowrite", input: { todos: [] } } })),
    ).toBeNull();
    expect(toolTaskChunk(step({ kind: "command", label: "todos", chip: "tool", code: { tool: "todowrite", input: { todos: [] } } }))).toBeNull();
  });

  test("a web search revises ONE card in place: started, then complete with its sources", () => {
    const search = (activityKind: string, output?: string) =>
      step({
        id: "call_1",
        label: "Web search started",
        chip: "search",
        code: { source: "t3", activityKind, tool: "web_search", input: { query: "bun test timeout" }, ...(output ? { output } : {}), error: false },
      });
    expect(toolTaskChunk(search("tool.started"))).toEqual({
      type: "task_update",
      id: "step_call_1",
      title: "Searched the web",
      status: "in_progress",
      details: "bun test timeout",
    });
    const done = toolTaskChunk(search("tool.completed", "Results:\nhttps://bun.sh/docs/cli/test\nhttps://bun.sh/docs/cli/test (again)\n"));
    expect(done).toEqual({
      type: "task_update",
      id: "step_call_1",
      title: "Searched the web",
      status: "complete",
      details: "bun test timeout",
      output: "Results:",
      sources: [{ type: "url", text: "https://bun.sh/docs/cli/test", url: "https://bun.sh/docs/cli/test" }],
    });
  });

  test("the verb table matches the web UI's tool rows", () => {
    const t3 = (tool: string, input: Record<string, unknown>, kind = "command") =>
      toolTaskChunk(step({ kind, label: tool, code: { source: "t3", activityKind: "tool.started", tool, input } }));
    expect(t3("memory_search", { query: "release notes" })).toMatchObject({ title: "Recalled memory", details: "release notes" });
    expect(t3("bash", { command: "bun test\n--bail" })).toMatchObject({ title: "Ran a command", details: "bun test" });
    expect(t3("edit", { file_path: "src/app.ts" }, "file")).toMatchObject({ title: "Edited a file", details: "src/app.ts" });
    expect(t3("read", { path: "README.md" })).toMatchObject({ title: "Read a file", details: "README.md" });
    // The gateway bridge names the real tool inside the input.
    expect(t3("execute", { name: "web_fetch", arguments: { url: "https://x.dev" } })).toMatchObject({ title: "Fetched a page", details: "https://x.dev" });
    // An uncatalogued tool keeps its own label.
    expect(t3("mcp.useagent.deploy", { name: "prod" })).toMatchObject({ title: "mcp.useagent.deploy", status: "in_progress" });
  });

  test("a failed call is an error card; a legacy step completes once it has output", () => {
    expect(toolTaskChunk(step({ label: "bash", code: { tool: "bash", input: { command: "make" }, output: "boom", error: true } }))).toMatchObject({ status: "error" });
    expect(toolTaskChunk(step({ label: "bash", code: { tool: "bash", input: { command: "make" } } }))).toMatchObject({ status: "in_progress" });
    expect(toolTaskChunk(step({ label: "bash", code: { tool: "bash", input: { command: "make" }, output: '{"stdout":"ok"}' } }))).toMatchObject({ status: "complete" });
    expect(toolTaskChunk(step({ label: "bash", code: { tool: "bash", output: '{"stdout":"ok"}' } }))?.output).toBeUndefined();
    // The native bridge completes a call by landing its output key, even empty.
    expect(toolTaskChunk(step({ label: "bash", code: { tool: "bash", input: { command: "make" }, output: "", error: false } }))).toMatchObject({ status: "complete" });
  });

  test("sources keep brackets that belong to the URL, shed the ones that wrapped it, and drop what the URL parser rejects", () => {
    const output = [
      "see (https://bun.sh/docs).",
      "local [http://[::1]:3000/health],",
      "[https://x.dev/a]",
      "{https://example.com/a}",
      "wiki https://w.org/Foo_(bar)",
      "broken https://%zz",
      "dup https://bun.sh/docs",
    ].join(" ");
    const chunk = toolTaskChunk(step({ label: "web_search", code: { tool: "web_search", input: { query: "q" }, output } }));
    expect(chunk?.sources?.map((s) => s.url)).toEqual([
      "https://bun.sh/docs",
      "http://[::1]:3000/health",
      "https://x.dev/a",
      "https://example.com/a",
      "https://w.org/Foo_(bar)",
    ]);
    expect(taskSourcesField([{ type: "url", text: "x", url: "http://[::1" }, { type: "url", text: "ok", url: "https://ok.dev" }])).toEqual({
      sources: [{ type: "url", text: "ok", url: "https://ok.dev" }],
    });
  });
});

describe("stepProgressChunks (open card pairing)", () => {
  const running = (id: string): ReturnType<typeof taskUpdateChunk> => taskUpdateChunk({ id, title: "Ran a command", status: "in_progress" });

  test("a new call completes the open card of an engine that never sends completions", () => {
    const first = stepProgressChunks(null, running("step_a"));
    expect(first.chunks).toEqual([running("step_a")]);
    const second = stepProgressChunks(first.open, running("step_b"));
    expect(second.chunks).toEqual([{ ...running("step_a"), status: "complete" }, running("step_b")]);
    expect(second.open?.id).toBe("step_b");
  });

  test("a revision of the open card and a completion of another card leave it open", () => {
    const open = running("step_b");
    expect(stepProgressChunks(open, { ...open, output: "line" }).chunks).toEqual([{ ...open, output: "line" }]);
    const other = { ...running("step_a"), status: "complete" as const };
    const result = stepProgressChunks(open, other);
    expect(result.chunks).toEqual([other]);
    expect(result.open).toBe(open);
    expect(stepProgressChunks(open, { ...open, status: "complete" }).open).toBeNull();
  });
});

describe("planUpdateFromStep", () => {
  const planStep = (todos: unknown) => ({
    label: "Update plan",
    chip: "plan",
    codeJson: JSON.stringify({ tool: "todowrite", input: { todos } }),
  });

  test("a todos step becomes ONE plan_update titled with live progress", () => {
    const chunk = planUpdateFromStep(
      planStep([
        { content: "Inspect request", status: "completed" },
        { content: "Make changes", status: "in_progress" },
        { content: "Verify", status: "pending" },
      ]),
    );
    expect(chunk).toEqual({ type: "plan_update", title: "Plan 1/3: Make changes" });
  });

  test("a todowrite step without the plan chip still counts (engine variance)", () => {
    const chunk = planUpdateFromStep({
      label: "todos",
      chip: null,
      codeJson: JSON.stringify({ tool: "todowrite", input: { todos: [{ content: "A", status: "pending" }] } }),
    });
    expect(chunk?.type).toBe("plan_update");
  });

  test("a plan-chip step with unparseable/missing todos falls back to its label", () => {
    expect(planUpdateFromStep({ label: "Plan updated", chip: "plan", codeJson: "{not json" })).toEqual({
      type: "plan_update",
      title: "Plan updated",
    });
  });

  test("a non-plan step yields nothing", () => {
    expect(planUpdateFromStep({ label: "bash", chip: "tool", codeJson: JSON.stringify({ tool: "bash" }) })).toBeNull();
  });
});

describe("terminalTaskChunks", () => {
  test("closes an open tool card, restates a settled one as is, then the root task", () => {
    const settled = taskUpdateChunk({ id: "step_s8", title: "Searched the web", status: "complete", sources: ["https://bun.sh"] });
    const chunks = terminalTaskChunks({
      phase: "completed",
      title: "Build the thing",
      cards: [settled, taskUpdateChunk({ id: "step_s9", title: "Ran a command", status: "in_progress" })],
    });
    expect(chunks).toEqual([
      settled,
      { type: "task_update", id: "step_s9", title: "Ran a command", status: "complete" },
      { type: "task_update", id: "run", title: "Build the thing", status: "complete" },
    ]);
  });

  test("the restatement stays within its budget: newest cards first, every card past it still closes bare", () => {
    const big = (id: string, status: "in_progress" | "complete" | "error") =>
      taskUpdateChunk({ id, title: "Searched the web", status, sources: [`https://x.dev/${"a".repeat(400)}`] });
    const cards = [big("step_1", "in_progress"), big("step_2", "error"), big("step_3", "complete")];
    // One card is ~950 chars of JSON: the budget fits exactly the newest one.
    expect(terminalTaskChunks({ phase: "completed", title: "T", cards, budget: 1_000 })).toEqual([
      { type: "task_update", id: "step_1", title: "Searched the web", status: "complete" },
      { type: "task_update", id: "step_2", title: "Searched the web", status: "error" },
      big("step_3", "complete"),
      { type: "task_update", id: "run", title: "T", status: "complete" },
    ]);
  });

  test("a card streamed in_progress whose oversized completion was fenced still closes at stop", () => {
    // Slack saw the card spinning live; the completion append (five long
    // sources) landed right before finalization and was fenced, so the stop
    // is the only place left for the card to settle - complete, not dropped.
    const sources = [1, 2, 3, 4, 5].map((k) => `https://x.dev/${k}/${"a".repeat(3_700)}`);
    const done = taskUpdateChunk({ id: "step_1", title: "Searched the web", status: "complete", sources });
    expect(JSON.stringify(done).length).toBeGreaterThan(TERMINAL_CARD_BUDGET);
    expect(terminalTaskChunks({ phase: "completed", title: "T", cards: [done] })).toEqual([
      { type: "task_update", id: "step_1", title: "Searched the web", status: "complete" },
      { type: "task_update", id: "run", title: "T", status: "complete" },
    ]);
    const failed = taskUpdateChunk({ id: "step_2", title: "Ran a command", status: "error", sources });
    expect(terminalTaskChunks({ phase: "completed", title: "T", cards: [failed] })[0]).toEqual(
      { type: "task_update", id: "step_2", title: "Ran a command", status: "error" },
    );
  });

  test("a failed run settles open cards and the root task as error", () => {
    const open = taskUpdateChunk({ id: "step_s9", title: "Ran a command", status: "in_progress" });
    expect(terminalTaskChunks({ phase: "failed", title: "Build", cards: [open] })).toEqual([
      { ...open, status: "error" },
      { type: "task_update", id: "run", title: "Run failed", status: "error" },
    ]);
    expect(terminalTaskChunks({ phase: "failed", title: "Build" })).toEqual([
      { type: "task_update", id: "run", title: "Run failed", status: "error" },
    ]);
  });
});

describe("composeStreamClosing (answer never lost, never grossly duplicated)", () => {
  test("no narration: the closing IS the reply", () => {
    expect(composeStreamClosing({ status: "completed", summary: "The answer.", narration: "" })).toBe("The answer.");
    expect(composeStreamClosing({ status: "completed", summary: "  ", narration: "" })).toBe("Done.");
  });

  test("narration containing the reply closes with nothing (no duplication)", () => {
    expect(
      composeStreamClosing({
        status: "completed",
        summary: "The answer.",
        narration: "Working through it...\n\nThe answer.",
      }),
    ).toBe("");
  });

  test("narration NOT containing the reply re-states it (correctness first)", () => {
    expect(
      composeStreamClosing({ status: "completed", summary: "The answer.", narration: "partial narr" }),
    ).toBe("\n\nThe answer.");
  });

  test("a failed run always appends the failure line", () => {
    expect(composeStreamClosing({ status: "failed", summary: "boom", narration: "" })).toBe("**Run failed**: boom");
    expect(composeStreamClosing({ status: "failed", summary: "boom", narration: "some text" })).toBe(
      "\n\n**Run failed**: boom",
    );
  });
});

describe("createNarrationBuffer (exact offsets, total cap)", () => {
  test("segments drain with exact char offsets", () => {
    const buffer = createNarrationBuffer();
    buffer.push("Hello ");
    buffer.push("world");
    expect(buffer.take()).toEqual({ text: "Hello world", offset: 0 });
    expect(buffer.take()).toBeNull();
    buffer.push("!");
    expect(buffer.take()).toEqual({ text: "!", offset: 11 });
    expect(buffer.streamed()).toBe(12);
  });

  test("the total cap bounds what a chatty run can stream", () => {
    const buffer = createNarrationBuffer(10);
    buffer.push("0123456789ABCDEF");
    expect(buffer.take()).toEqual({ text: "0123456789", offset: 0 });
    buffer.push("more");
    expect(buffer.take()).toBeNull();
    expect(buffer.streamed()).toBe(10);
  });
});

describe("shimmer + surface helpers", () => {
  test("the working status derives from the step label", () => {
    expect(statusTextForStep("useAgent · computer_sequence")).toBe("is working: useAgent · computer_sequence");
  });

  test("DM channel ids are recognized by their D prefix", () => {
    expect(directMessageChannel("D0123")).toBe(true);
    expect(directMessageChannel("C0123")).toBe(false);
  });
});
