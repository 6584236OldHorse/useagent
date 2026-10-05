// CONTRACT-SHAPED: these V2 frames are built from the runtime contract
// (packages/contracts/src/orchestrationV2.ts at upstream ce90eec1f), not
// recorded from a running runtime. Re-check them against the spike's recorded
// frames (~/output/t3-v2/frames) and replace them with recordings.
import { describe, expect, test } from "bun:test";
import { attachRuntimeSocket, runtimeSocketUrl } from "./runtime-rpc-socket";
import { RuntimeRpcError } from "./runtime-v2-wire";

class FakeSocket {
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  ping() {}
  addEventListener() {}
  removeEventListener() {}
  close() { this.closed = true; this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  drop() { this.readyState = 3; this.onclose?.(); }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function connected(signal = new AbortController().signal) {
  const fake = new FakeSocket();
  const pending = attachRuntimeSocket(fake as unknown as WebSocket, signal, () => {});
  fake.open();
  return { fake, socket: await pending };
}

describe("provider runtime socket", () => {
  test("builds the protocol 2 socket URL with the one-time ticket", () => {
    const url = new URL(runtimeSocketUrl("https://sbx-37733.example.dev/", "ticket-abc"));
    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/ws");
    expect(url.searchParams.get("wsTicket")).toBe("ticket-abc");
    expect(url.searchParams.get("orchestrationProtocol")).toBe("2");
  });

  test("streams chunk values in order, acknowledging each, until the Exit", async () => {
    const { fake, socket } = await connected();
    const seen: unknown[] = [];
    const done = socket.stream("orchestration.subscribeThread", { threadId: "t" }, async (values) => {
      seen.push(...values);
      return true;
    });
    expect(fake.sent[0]).toEqual({
      _tag: "Request", id: 1, tag: "orchestration.subscribeThread", payload: { threadId: "t" }, headers: [],
    });
    fake.receive({ _tag: "Chunk", requestId: 1, values: [{ n: 1 }, { n: 2 }] });
    fake.receive({ _tag: "Chunk", requestId: 1, values: [{ n: 3 }] });
    fake.receive({ _tag: "Exit", requestId: 1, exit: { _tag: "Success", value: null } });
    await done;
    expect(seen).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(fake.sent.filter((frame) => frame._tag === "Ack")).toEqual([
      { _tag: "Ack", requestId: 1 }, { _tag: "Ack", requestId: 1 },
    ]);
  });

  test("answers a call with its success value and numbers requests in order", async () => {
    const { fake, socket } = await connected();
    const answer = socket.call("orchestration.dispatchCommand", { type: "run.interrupt" });
    expect(fake.sent[0]).toMatchObject({ _tag: "Request", id: 1, tag: "orchestration.dispatchCommand" });
    fake.receive({ _tag: "Exit", requestId: 1, exit: { _tag: "Success", value: { sequence: 9 } } });
    expect(await answer).toEqual({ sequence: 9 });
    void socket.call("orchestration.dispatchCommand", {});
    expect(fake.sent[1]).toMatchObject({ id: 2 });
  });

  test("turns a refused command into a RuntimeRpcError naming the orchestrator's reason", async () => {
    const { fake, socket } = await connected();
    const answer = socket.call("orchestration.dispatchCommand", { type: "provider-session.detach" });
    fake.receive({
      _tag: "Exit",
      requestId: 1,
      exit: {
        _tag: "Failure",
        cause: [{
          _tag: "Fail",
          error: {
            _tag: "OrchestrationV2DispatchCommandError",
            commandId: "c1",
            commandType: "provider-session.detach",
            message: "Failed to dispatch orchestration V2 command",
            detail: "Provider session s1 does not belong to thread t.",
            cause: { _tag: "OrchestratorDispatchError", commandId: "c1" },
          },
        }],
      },
    });
    const error = await answer.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeRpcError);
    const rpc = error as RuntimeRpcError;
    expect(rpc.errorTag).toBe("OrchestrationV2DispatchCommandError");
    expect(rpc.detail).toBe("Provider session s1 does not belong to thread t.");
    expect(rpc.causeTags).toEqual(["Fail", "OrchestrationV2DispatchCommandError", "OrchestratorDispatchError"]);
    expect(rpc.message).toContain("does not belong to thread");
  });

  test("a stream handler may await a call on the same socket without stalling it", async () => {
    const { fake, socket } = await connected();
    let answered: unknown;
    const done = socket.stream("orchestration.subscribeThread", {}, async () => {
      answered = await socket.call("orchestration.dispatchCommand", { type: "runtime-request.respond" });
      return false;
    });
    fake.receive({ _tag: "Chunk", requestId: 1, values: [{ kind: "event" }] });
    await tick();
    expect(fake.sent.at(-1)).toMatchObject({ _tag: "Request", id: 2 });
    fake.receive({ _tag: "Exit", requestId: 2, exit: { _tag: "Success", value: { sequence: 3 } } });
    await done;
    expect(answered).toEqual({ sequence: 3 });
    expect(fake.sent.at(-1)).toEqual({ _tag: "Interrupt", requestId: 1 });
  });

  test("a lost socket fails the open call at once and the stream after its delivered values", async () => {
    const { fake, socket } = await connected();
    const handled: unknown[] = [];
    const stream = socket.stream("orchestration.subscribeThread", {}, async (values) => {
      handled.push(...values);
      return true;
    });
    const call = socket.call("orchestration.dispatchCommand", {}).catch((error: Error) => error.message);
    const streamEnd = stream.catch((error: Error) => error.message);
    fake.receive({ _tag: "Chunk", requestId: 1, values: [{ n: 1 }] });
    fake.drop();
    expect(await call).toBe("The provider stream closed");
    expect(await streamEnd).toBe("The provider stream closed");
    expect(handled).toEqual([{ n: 1 }]);
  });

  test("a local abort ends streams quietly and fails calls", async () => {
    const controller = new AbortController();
    const { fake, socket } = await connected(controller.signal);
    const stream = socket.stream("orchestration.subscribeThread", {}, async () => true);
    const call = socket.call("orchestration.dispatchCommand", {}).catch((error: Error) => error.message);
    controller.abort(new Error("turn aborted"));
    await expect(stream).resolves.toBeUndefined();
    expect(await call).toBe("turn aborted");
    expect(fake.closed).toBe(true);
    expect(fake.sent).toContainEqual({ _tag: "Interrupt", requestId: 1 });
  });

  test("an abort or a stall before the socket opens rejects the open", async () => {
    const controller = new AbortController();
    const aborted = attachRuntimeSocket(new FakeSocket() as unknown as WebSocket, controller.signal, () => {});
    controller.abort(new Error("turn aborted"));
    await expect(aborted).rejects.toThrow("turn aborted");
    const stalled = attachRuntimeSocket(new FakeSocket() as unknown as WebSocket, new AbortController().signal, () => {}, 5);
    await expect(stalled).rejects.toThrow("did not open");
  });

  test("a socket that fails before opening rejects the open", async () => {
    const fake = new FakeSocket();
    const pending = attachRuntimeSocket(fake as unknown as WebSocket, new AbortController().signal, () => {});
    fake.onerror?.();
    await expect(pending).rejects.toThrow("connection failed");
  });
});
