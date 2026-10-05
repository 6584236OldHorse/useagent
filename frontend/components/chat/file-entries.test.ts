import { describe, expect, test } from "bun:test";
import { changedFilesFromTimeline } from "@/components/session-ui/adapter";
import { filesFromSteps, stepFailed } from "./file-entries";
import { type ApiStep, parseFileEntries } from "./types";

// The runtime projection hands the UI file changes as `files:[{path, kind?}]`
// under the tool input (codex apply_patch, opencode edit) or, once the backend
// has recovered it, as `file_path` (claude). Both shapes must list every file;
// a failed write touched nothing.
function fileStep(id: string, code: Record<string, unknown>, kind: ApiStep["kind"] = "file"): ApiStep {
  return {
    id,
    run_id: "r1",
    idx: 0,
    kind,
    chip: "file",
    label: id,
    code_json: JSON.stringify({ tool: "edit", ...code }),
    created_at: new Date(1_700_000_000_000).toISOString(),
  };
}

describe("parseFileEntries", () => {
  test("lists every path of a files[] input, keeping each entry's change kind", () => {
    const entries = parseFileEntries(
      fileStep("multi", { input: { files: [{ path: "src/a.ts" }, { path: "src/b.ts", kind: "add" }] } }),
    );
    expect(entries.map((e) => [e.path, e.base, e.kind])).toEqual([
      ["src/a.ts", "a.ts", "edit"],
      ["src/b.ts", "b.ts", "add"],
    ]);
  });

  test("attaches a mirrored body only to a single-file change", () => {
    const single = parseFileEntries(
      fileStep("one", { input: { files: [{ path: "a.ts" }], content: "export {}" } }),
    );
    expect(single[0]?.content).toBe("export {}");
    const multi = parseFileEntries(
      fileStep("two", { input: { files: [{ path: "a.ts" }, { path: "b.ts" }], content: "export {}" } }),
    );
    expect(multi.map((e) => e.content)).toEqual([undefined, undefined]);
  });

  test("still reads a plain file_path input", () => {
    const entries = parseFileEntries(fileStep("claude", { input: { file_path: "/w/app.ts" } }));
    expect(entries.map((e) => e.path)).toEqual(["/w/app.ts"]);
  });
});

describe("filesFromSteps", () => {
  test("de-duplicates across steps, latest kind winning, and skips failed writes", () => {
    const files = filesFromSteps([
      fileStep("first", { input: { files: [{ path: "a.ts", kind: "add" }] } }),
      fileStep("again", { input: { files: [{ path: "a.ts" }] } }),
      fileStep("failed", { input: { file_path: "never.ts" }, error: true }),
      fileStep("command", { input: { file_path: "cmd.ts" } }, "command"),
    ]);
    expect(files.map((f) => [f.path, f.kind])).toEqual([["a.ts", "edit"]]);
  });

  test("the Diff adapter and the Editor agree on a failed write", () => {
    const failed = fileStep("failed", { input: { file_path: "never.ts" }, error: true });
    const applied = fileStep("ok", { input: { file_path: "done.ts" } });
    expect(stepFailed(failed)).toBe(true);
    expect(stepFailed(applied)).toBe(false);
    const nodes = [failed, applied].map((step) => ({ kind: "tool" as const, key: step.id, step }));
    expect(changedFilesFromTimeline(nodes).map((f) => f.path)).toEqual(["done.ts"]);
    expect(filesFromSteps([failed, applied]).map((f) => f.path)).toEqual(["done.ts"]);
  });
});
