import { describe, expect, test } from "bun:test";
import type { SandboxHandle } from "../sandboxes/provider";
import type { RuntimeEnvironmentRequest } from "./runtime-environment-client";
import type { RuntimeMode, RuntimeThreadSnapshot } from "./runtime-orchestration";
import { ensureRuntimeThreadMode } from "./runtime-thread-mode";

function snapshot(runtimeMode: RuntimeMode | undefined, sequence = 1): RuntimeThreadSnapshot {
  return {
    snapshotSequence: sequence,
    thread: {
      id: "skynet-thread-thread-1",
      ...(runtimeMode ? { runtimeMode } : {}),
      latestTurn: null,
      messages: [],
      activities: [],
      session: null,
    },
  };
}

function harness(reported: Array<RuntimeMode | undefined>) {
  const requests: RuntimeEnvironmentRequest[] = [];
  let reads = 0;
  const request = (async (_sandbox: SandboxHandle, req: RuntimeEnvironmentRequest) => {
    requests.push(req);
    if (req.method === "GET") {
      const mode = reported[Math.min(reads, reported.length - 1)];
      reads += 1;
      return snapshot(mode, 10 + reads);
    }
    return {};
  }) as unknown as NonNullable<Parameters<typeof ensureRuntimeThreadMode>[0]["request"]>;
  return { requests, request };
}

describe("runtime thread mode before a turn", () => {
  test("a thread already in the run's mode is left alone", async () => {
    const { requests, request } = harness([]);
    const prior = snapshot("full-access");
    const result = await ensureRuntimeThreadMode({
      sandbox: {} as SandboxHandle,
      threadId: "skynet-thread-thread-1",
      runtimeMode: "full-access",
      snapshot: prior,
      signal: new AbortController().signal,
      request,
    });
    expect(result).toBe(prior);
    expect(requests).toEqual([]);
  });

  test("a reply that changes the mode sets it on the thread and proceeds once the runtime reports it", async () => {
    const { requests, request } = harness(["full-access", "approval-required"]);
    const result = await ensureRuntimeThreadMode({
      sandbox: {} as SandboxHandle,
      threadId: "skynet-thread-thread-1",
      runtimeMode: "approval-required",
      snapshot: snapshot("full-access"),
      signal: new AbortController().signal,
      request,
      settleIntervalMs: 1,
    });
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/api/orchestration/dispatch",
      payload: { type: "thread.runtime-mode.set", threadId: "skynet-thread-thread-1", runtimeMode: "approval-required" },
    });
    expect(requests.slice(1).every((req) => req.method === "GET")).toBe(true);
    expect(result.thread.runtimeMode).toBe("approval-required");
    expect(result.snapshotSequence).toBe(12);
  });

  test("a thread that keeps its old mode fails the turn instead of running wider than the run allows", async () => {
    const { request } = harness(["full-access"]);
    await expect(ensureRuntimeThreadMode({
      sandbox: {} as SandboxHandle,
      threadId: "skynet-thread-thread-1",
      runtimeMode: "approval-required",
      snapshot: snapshot("full-access"),
      signal: new AbortController().signal,
      request,
      settleIntervalMs: 1,
    })).rejects.toThrow("kept thread mode full-access instead of approval-required");
    const unknown = harness([undefined]);
    await expect(ensureRuntimeThreadMode({
      sandbox: {} as SandboxHandle,
      threadId: "skynet-thread-thread-1",
      runtimeMode: "approval-required",
      snapshot: snapshot(undefined),
      signal: new AbortController().signal,
      request: unknown.request,
      settleIntervalMs: 1,
    })).rejects.toThrow("kept thread mode unknown");
  });
});
