import { describe, expect, test } from "bun:test";
import { decodeDataFrame, encodeControlFrame, encodeDataFrame, parseControlFrame } from "./frames";

describe("data frames", () => {
  test("round-trip the stream id and payload", () => {
    const payload = new Uint8Array([1, 2, 3, 250, 251, 252]);
    const decoded = decodeDataFrame(encodeDataFrame(0xfedc_ba98, payload));
    expect(decoded?.streamId).toBe(0xfedc_ba98);
    expect([...(decoded?.payload ?? [])]).toEqual([...payload]);
  });

  test("decode from a view into a larger buffer", () => {
    const frame = encodeDataFrame(7, new Uint8Array([9, 9]));
    const padded = new Uint8Array(frame.byteLength + 4);
    padded.set(frame, 2);
    const decoded = decodeDataFrame(padded.subarray(2, 2 + frame.byteLength));
    expect(decoded?.streamId).toBe(7);
    expect([...(decoded?.payload ?? [])]).toEqual([9, 9]);
  });

  test("reject a short frame and an unknown tag", () => {
    expect(decodeDataFrame(new Uint8Array([1, 0, 0]))).toBeNull();
    expect(decodeDataFrame(new Uint8Array([2, 0, 0, 0, 1, 5]))).toBeNull();
  });
});

describe("control frames", () => {
  test("round-trip every frame type", () => {
    const frames = [
      { t: "rpc", id: 1, method: "sandbox.get", params: { sandboxId: "abc" } },
      { t: "rpc.result", id: 1, result: null },
      { t: "rpc.error", id: 2, code: "not_found", message: "gone" },
      { t: "stream.open", id: 2, target: { kind: "port", sandboxId: "abc", port: 80 } },
      { t: "stream.opened", id: 2 },
      { t: "stream.refused", id: 4, code: "refused", message: "no" },
      { t: "stream.credit", id: 2, bytes: 4096 },
      { t: "stream.close", id: 2 },
      { t: "stream.reset", id: 2, reason: "bye" },
      { t: "event", sandboxId: null, kind: "image.refreshed", detail: { digest: "sha256:1" } },
    ] as const;
    for (const frame of frames) {
      expect(parseControlFrame(encodeControlFrame(frame))).toEqual(frame);
    }
  });

  test("ignore malformed and unknown frames", () => {
    expect(parseControlFrame("not json")).toBeNull();
    expect(parseControlFrame("[]")).toBeNull();
    expect(parseControlFrame(JSON.stringify({ t: "later.frame", id: 1 }))).toBeNull();
    expect(parseControlFrame(JSON.stringify({ t: "rpc", id: "1", method: "x" }))).toBeNull();
    expect(parseControlFrame(JSON.stringify({ t: "rpc", id: -1, method: "x" }))).toBeNull();
    expect(parseControlFrame(JSON.stringify({ t: "stream.credit", id: 1, bytes: 0 }))).toBeNull();
    expect(parseControlFrame(JSON.stringify({ t: "stream.reset", id: 1 }))).toBeNull();
    expect(parseControlFrame(JSON.stringify({ t: "hello" }))).toBeNull();
    expect(parseControlFrame(JSON.stringify({ t: "welcome", protocol: 1 }))).toBeNull();
  });

  test("hello, welcome, heartbeat and event need their required fields", () => {
    const capacity = { cpu: 4, memoryMb: 8192, sandboxes: 1 };
    const hello = { t: "hello", runnerId: "r", version: "0.1.0", protocol: 1, backend: "docker", platform: "darwin-arm64", capacity, logins: ["codex"], imageDigest: null };
    expect(parseControlFrame(JSON.stringify(hello))).toEqual(hello as never);
    expect(parseControlFrame(JSON.stringify({ ...hello, capacity: {} }))).toBeNull();
    expect(parseControlFrame(JSON.stringify({ ...hello, logins: "codex" }))).toBeNull();
    // The backend is one of the kinds the type names, so a caller can trust the union.
    expect(parseControlFrame(JSON.stringify({ ...hello, backend: "apple" }))).toEqual({ ...hello, backend: "apple" } as never);
    expect(parseControlFrame(JSON.stringify({ ...hello, backend: "bogus" }))).toBeNull();
    const welcome = { t: "welcome", protocol: 1, minProtocol: 1, image: { ref: "r", digest: "sha256:0" }, heartbeatSeconds: 15, release: "abc" };
    expect(parseControlFrame(JSON.stringify(welcome))).toEqual(welcome as never);
    expect(parseControlFrame(JSON.stringify({ ...welcome, image: { ref: "r" } }))).toBeNull();
    const heartbeat = { t: "heartbeat", capacity, logins: [], imageDigest: "sha256:0" };
    expect(parseControlFrame(JSON.stringify(heartbeat))).toEqual(heartbeat as never);
    expect(parseControlFrame(JSON.stringify({ t: "heartbeat" }))).toBeNull();
    expect(parseControlFrame(JSON.stringify({ t: "event", sandboxId: null, kind: "x", detail: 1 }))).not.toBeNull();
    expect(parseControlFrame(JSON.stringify({ t: "event", sandboxId: 5, kind: "x" }))).toBeNull();
    // detail is part of the frame, even when it is null.
    expect(parseControlFrame(JSON.stringify({ t: "event", sandboxId: null, kind: "x", detail: null }))).not.toBeNull();
    expect(parseControlFrame(JSON.stringify({ t: "event", sandboxId: null, kind: "x" }))).toBeNull();
  });

  test("credit must be a positive safe integer", () => {
    expect(parseControlFrame('{"t":"stream.credit","id":1,"bytes":1e309}')).toBeNull();
    expect(parseControlFrame('{"t":"stream.credit","id":1,"bytes":1.5}')).toBeNull();
    expect(parseControlFrame('{"t":"stream.credit","id":1,"bytes":-3}')).toBeNull();
    expect(parseControlFrame('{"t":"stream.credit","id":1,"bytes":64}')).toEqual({ t: "stream.credit", id: 1, bytes: 64 });
  });

  test("keep unknown optional fields for forward compatibility", () => {
    const parsed = parseControlFrame(JSON.stringify({ t: "stream.close", id: 3, later: "field" }));
    expect(parsed).toEqual({ t: "stream.close", id: 3, later: "field" } as never);
  });
});
