import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { RuntimeThreadSnapshot } from "./runtime-orchestration";
import { landUnsettledTurn } from "./runtime-stop-accounting";

const snapshot: RuntimeThreadSnapshot = {
  snapshotSequence: 12,
  thread: { id: "skynet-thread-1", latestTurn: null, messages: [], activities: [], session: null },
};

describe("landing an unsettled runtime turn", () => {
  const turn = (
    input: { settled: boolean; stopping: boolean; dispatched?: boolean; cancelFails?: boolean },
    calls: string[],
  ) => ({
    dispatched: input.dispatched ?? true,
    settled: input.settled,
    stopping: input.stopping,
    cancel: async () => {
      calls.push("cancel");
      if (input.cancelFails) throw new Error("cancel refused");
    },
    read: async () => {
      calls.push("read");
      return snapshot;
    },
    apply: async () => {
      calls.push("apply");
    },
  });

  test("a lost transport without Stop cancels the provider first, then lands the interruption's usage", async () => {
    const calls: string[] = [];
    expect(await landUnsettledTurn(turn({ settled: false, stopping: false }, calls))).toBe("landed");
    expect(calls).toEqual(["cancel", "read", "apply"]);
  });

  test("a settled turn, or one never dispatched, owes nothing", async () => {
    const calls: string[] = [];
    expect(await landUnsettledTurn(turn({ settled: true, stopping: false }, calls))).toBe("nothing");
    expect(await landUnsettledTurn(turn({ settled: false, stopping: false, dispatched: false }, calls))).toBe("nothing");
    expect(calls).toEqual([]);
  });

  test("a refused cancel is logged after a lost transport, and is the failure on Stop", async () => {
    expect(await landUnsettledTurn(turn({ settled: false, stopping: false, cancelFails: true }, []))).toBe("cancel_failed");
    await expect(landUnsettledTurn(turn({ settled: false, stopping: true, cancelFails: true }, []))).rejects.toThrow("cancel refused");
  });

  test("the adapter's cleanup lands every unsettled turn, not only a stopped one", () => {
    const source = readFileSync(new URL("./runtime-adapter.ts", import.meta.url), "utf8");
    expect(source).toContain("await landUnsettledTurn({");
    expect(source).not.toContain("if (ctx.signal.aborted && !skipQueuedCancel)");
  });
});
