import { describe, expect, test } from "bun:test";
import { changedFilesFromTimeline } from "@/components/session-ui/adapter";
import { buildTimelineFromCanonical, type CanonicalEventLike } from "./canonical-timeline";
import type { ApiStep } from "./types";

// The runtime engines' lifecycle events name a provider call id but not the durable
// step's event ids, so the sidecar step (which carries the repaired file input) has
// to be found by the call id it stores under code_json.native.callID; otherwise the
// canonical lane falls back to a synthetic command row with no files.
function fileStep(id: string, callID: string, paths: string[]): ApiStep {
  return {
    id,
    run_id: "r1",
    idx: 3,
    kind: "file",
    chip: "tool.completed",
    label: "File change",
    code_json: JSON.stringify({
      source: "t3",
      tool: "edit",
      input: { file_path: paths[0], files: paths.map((path) => ({ path })) },
      native: { callID },
    }),
    created_at: new Date(1_700_000_000_000).toISOString(),
  };
}

function lifecycle(toolCallId: string, nativeEventId: string): CanonicalEventLike[] {
  return [
    { kind: "tool.started", seq: 1, toolCallId, name: "edit", title: "File change", identity: { nativeEventId: `${nativeEventId}-start` } },
    { kind: "tool.completed", seq: 2, toolCallId, name: "edit", status: "ok", identity: { nativeEventId } },
  ] as unknown as CanonicalEventLike[];
}

describe("canonical timeline sidecar lookup", () => {
  test("resolves the durable step by provider call id when event ids do not match", () => {
    const step = fileStep("step-9", "call-9", ["src/a.ts", "src/b.ts"]);
    const nodes = buildTimelineFromCanonical(
      lifecycle("call-9", "evt-9"),
      new Map([[step.id, step]]),
      false,
    );
    const tool = nodes.find((node) => node.kind === "tool");
    expect(tool && tool.kind === "tool" ? tool.step.id : null).toBe("step-9");
    expect(changedFilesFromTimeline(nodes).map((file) => file.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  test("still prefers a step matched by event id", () => {
    const byEvent = fileStep("evt-9", "call-9", ["by-event.ts"]);
    const byCall = fileStep("step-other", "call-9", ["by-call.ts"]);
    const nodes = buildTimelineFromCanonical(
      lifecycle("call-9", "evt-9"),
      new Map([[byEvent.id, byEvent], [byCall.id, byCall]]),
      false,
    );
    expect(changedFilesFromTimeline(nodes).map((file) => file.path)).toEqual(["by-event.ts"]);
  });
});
