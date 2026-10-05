import { describe, expect, test } from "bun:test";
import { compressTerminalLog } from "./terminal-log-model";
import type { ApiStep } from "./types";

// A runtime engine's command step carries no exit code, and a silent command no
// output, so the Log tab used to keep a finished `true` marked in flight until
// the next entry landed. The lifecycle kind on the step says it is done.
function commandStep(id: string, code: Record<string, unknown>): ApiStep {
  return {
    id,
    run_id: "r1",
    idx: 1,
    kind: "command",
    chip: "tool.completed",
    label: "Command run",
    code_json: JSON.stringify({ source: "t3", tool: "bash", ...code }),
    created_at: new Date(1_700_000_000_000).toISOString(),
  };
}

describe("compressTerminalLog settles runtime commands", () => {
  test("a completed silent command is settled", () => {
    const [entry] = compressTerminalLog([
      commandStep("silent", { activityKind: "tool.completed", input: { command: "true" }, error: false }),
    ]);
    expect(entry).toMatchObject({ kind: "command", command: "true", lines: [], settled: true });
  });

  test("a command still running is not settled", () => {
    const [entry] = compressTerminalLog([
      commandStep("running", { activityKind: "tool.started", input: { command: "sleep 5" }, error: false }),
    ]);
    expect(entry).toMatchObject({ kind: "command", settled: false });
  });

  test("a denied command is settled and failed", () => {
    const [entry] = compressTerminalLog([
      commandStep("denied", { activityKind: "tool.denied", input: { command: "rm -rf /" }, error: true }),
    ]);
    expect(entry).toMatchObject({ kind: "command", settled: true, failed: true });
  });
});
