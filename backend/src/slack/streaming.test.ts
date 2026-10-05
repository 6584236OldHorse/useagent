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
  markdownChunksFor,
  taskSourcesField,
  taskUpdateChunk,
  toolTaskChunk,
  WORKING_PHRASES,
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

  test("a markdown chunk boundary never splits a surrogate pair", () => {
    const text = `${"x".repeat(9_999)}😀${"y".repeat(20)}`;
    const chunks = markdownChunksFor(text);
    expect(chunks.map((c) => c.text).join("")).toBe(text);
    expect(chunks.every((c) => c.text.isWellFormed())).toBe(true);
    expect(chunks[0]!.text.length).toBe(9_999);
  });

  test("a capped task title never ends in a lone surrogate", () => {
    const chunk = taskUpdateChunk({ id: "t", title: `${"y".repeat(248)}😀zz`, status: "complete" });
    expect(chunk.title.isWellFormed()).toBe(true);
    expect(chunk.title.length).toBeLessThanOrEqual(250);
  });

  test("task titles cap under Slack's 256-char limit", () => {
    const chunk = taskUpdateChunk({ id: "t", title: "y".repeat(400), status: "complete" });
    expect(chunk.title.length).toBeLessThanOrEqual(250);
    expect(chunk.title.endsWith("…")).toBe(true);
  });

});

describe("toolTaskChunk (the card's verb per tool call, chatter never)", () => {
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

  test("a long reply is never cut: the caller splits what one message cannot hold", () => {
    const summary = "x".repeat(15_000) + "Z";
    expect(composeStreamClosing({ status: "completed", summary, narration: "" })).toBe(summary);
    expect(composeStreamClosing({ status: "failed", summary, narration: "" })).toBe(`**Run failed**: ${summary}`);
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

  test("the cap never leaves a lone surrogate on the stream", () => {
    const buffer = createNarrationBuffer(10);
    buffer.push("abcdefghi😀jk");
    const segment = buffer.take();
    expect(segment?.text).toBe("abcdefghi");
    expect(segment?.text.isWellFormed()).toBe(true);
    expect(buffer.streamed()).toBe(9);
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

describe("the working shimmer", () => {
  test("is a small set of calm phrases Slack can rotate, never a tool label", () => {
    expect(WORKING_PHRASES.length).toBeLessThanOrEqual(10);
    expect(WORKING_PHRASES[0]).toBe("Working on it");
    for (const phrase of WORKING_PHRASES) {
      expect(phrase).toMatch(/^[A-Z][a-z ]+$/);
      expect(phrase.length).toBeLessThan(40);
    }
  });
});
