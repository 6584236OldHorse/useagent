import { describe, expect, test } from "bun:test";
import type { SandboxHandle } from "../sandboxes/provider";
import { dispatchRuntimeCommand, registerRuntimeTurnSocket } from "./runtime-dispatch";
import type { RuntimeSocket } from "./runtime-rpc-socket";
import { RuntimeRpcError } from "./runtime-v2-wire";

const sandbox = { id: "sandbox-dispatch" } as SandboxHandle;
const command = { type: "run.interrupt", commandId: "c1", threadId: "t1", runId: "r1" };

function socket(call: RuntimeSocket["call"]): RuntimeSocket & { closed: number } {
  const value = { closed: 0, call, async stream() {}, close() { value.closed += 1; } };
  return value;
}

describe("runtime command dispatch", () => {
  test("uses the turn's subscribed socket for its own thread, else a one-shot socket it closes", async () => {
    const turn = socket(async () => ({ sequence: 7 }));
    const withdraw = registerRuntimeTurnSocket(sandbox.id, "t1", turn);
    const opened: RuntimeSocket[] = [];
    const open = async () => {
      const oneShot = socket(async () => ({ sequence: 8 }));
      opened.push(oneShot);
      return oneShot;
    };
    try {
      await expect(dispatchRuntimeCommand(sandbox, command, new AbortController().signal, { open: open as never })).resolves.toEqual({ sequence: 7 });
      expect(opened).toHaveLength(0);
      await expect(dispatchRuntimeCommand(sandbox, { ...command, threadId: "t2" }, new AbortController().signal, { open: open as never }))
        .resolves.toEqual({ sequence: 8 });
      expect(opened).toHaveLength(1);
      expect((opened[0] as ReturnType<typeof socket>).closed).toBe(1);
    } finally {
      withdraw();
    }
  });

  test("a lost turn socket retries once on a fresh one; the runtime's own refusal is not retried", async () => {
    const lost = registerRuntimeTurnSocket(sandbox.id, "t1", socket(async () => { throw new Error("The provider stream closed"); }));
    try {
      await expect(dispatchRuntimeCommand(sandbox, command, new AbortController().signal, {
        open: (async () => socket(async () => ({ sequence: 9 }))) as never,
      })).resolves.toEqual({ sequence: 9 });
    } finally {
      lost();
    }
    const refusal = new RuntimeRpcError("orchestration.dispatchCommand", "OrchestrationV2DispatchCommandError", "refused", undefined, []);
    const refused = registerRuntimeTurnSocket(sandbox.id, "t1", socket(async () => { throw refusal; }));
    try {
      await expect(dispatchRuntimeCommand(sandbox, command, new AbortController().signal, {
        open: (async () => { throw new Error("must not reopen"); }) as never,
      })).rejects.toBe(refusal);
    } finally {
      refused();
    }
  });

  test("a runtime that never answers does not hold the caller", async () => {
    const controller = new AbortController();
    const waiting = dispatchRuntimeCommand(sandbox, command, controller.signal, {
      open: (async () => socket(() => new Promise(() => {}))) as never,
    });
    controller.abort(new Error("turn aborted"));
    await expect(waiting).rejects.toThrow("turn aborted");
  });

  test("an invalid receipt is an error", async () => {
    await expect(dispatchRuntimeCommand(sandbox, command, new AbortController().signal, {
      open: (async () => socket(async () => ({}))) as never,
    })).rejects.toThrow("invalid dispatch receipt");
  });
});
