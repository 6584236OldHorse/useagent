import { describe, expect, test } from "bun:test";
import type { SandboxHandle } from "../sandboxes/provider";
import { runtimeModeFor } from "./permission-mode";
import type { RuntimeEnvironmentRequest } from "./runtime-environment-client";
import {
  buildRuntimeTurnStartCommand,
  type RuntimeMode,
  type RuntimeThreadSnapshot,
} from "./runtime-orchestration";
import { ensureRuntimeThreadMode } from "./runtime-thread-mode";

type RequestFn = NonNullable<Parameters<typeof ensureRuntimeThreadMode>[0]["request"]>;
const SANDBOX = {} as SandboxHandle;
const THREAD = "skynet-thread-thread-1";

function snapshot(runtimeMode: RuntimeMode | undefined, sequence = 1): RuntimeThreadSnapshot {
  return {
    snapshotSequence: sequence,
    thread: {
      id: THREAD,
      ...(runtimeMode ? { runtimeMode } : {}),
      latestTurn: null,
      messages: [],
      activities: [],
      session: null,
    },
  };
}

/** A request fake that answers reads with the given modes in order (the last one repeats). */
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
  }) as unknown as RequestFn;
  return { requests, request };
}

/**
 * The pinned runtime's recorded behaviour (native runtime manifest commit
 * 90dc3ebb): a turn start takes its mode from the STORED thread, the decider
 * emits targetThread.runtimeMode and ignores the command's, and only
 * thread.runtime-mode.set changes the stored thread. This fake is that record;
 * it is what the adapter's mode step exists for.
 */
function recordedRuntime(initialMode: RuntimeMode) {
  const thread = { runtimeMode: initialMode, sequence: 1 };
  const turns: RuntimeMode[] = [];
  const request = (async (_sandbox: SandboxHandle, req: RuntimeEnvironmentRequest) => {
    if (req.method === "GET") return snapshot(thread.runtimeMode, thread.sequence);
    const command = req.payload as { type: string; runtimeMode?: RuntimeMode };
    if (command.type === "thread.runtime-mode.set" && command.runtimeMode) {
      thread.runtimeMode = command.runtimeMode;
      thread.sequence += 1;
    } else if (command.type === "thread.turn.start") {
      turns.push(thread.runtimeMode);
      thread.sequence += 1;
    }
    return {};
  }) as unknown as RequestFn;
  const startTurn = (runtimeMode: RuntimeMode) =>
    request(
      SANDBOX,
      {
        method: "POST",
        path: "/api/orchestration/dispatch",
        payload: buildRuntimeTurnStartCommand(
          { runId: "run-2", threadId: "thread-1", model: undefined },
          "codex",
          "change the file",
          "2026-09-13T00:00:00.000Z",
          false,
          runtimeMode,
        ),
      },
      new AbortController().signal,
    );
  return { thread, turns, request, startTurn };
}

describe("runtime thread mode before a turn", () => {
  test("a thread already in the run's mode is left alone", async () => {
    const { requests, request } = harness([]);
    const prior = snapshot("full-access");
    const result = await ensureRuntimeThreadMode({
      sandbox: SANDBOX,
      threadId: THREAD,
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
      sandbox: SANDBOX,
      threadId: THREAD,
      runtimeMode: "approval-required",
      snapshot: snapshot("full-access"),
      signal: new AbortController().signal,
      request,
      settleIntervalMs: 1,
    });
    expect(requests[0]).toMatchObject({
      method: "POST",
      path: "/api/orchestration/dispatch",
      payload: { type: "thread.runtime-mode.set", threadId: THREAD, runtimeMode: "approval-required" },
    });
    expect(requests.slice(1).every((req) => req.method === "GET")).toBe(true);
    expect(result.thread.runtimeMode).toBe("approval-required");
    expect(result.snapshotSequence).toBe(12);
  });

  test("a thread that keeps its old mode fails the turn instead of running wider than the run allows", async () => {
    const { request } = harness(["full-access"]);
    await expect(ensureRuntimeThreadMode({
      sandbox: SANDBOX,
      threadId: THREAD,
      runtimeMode: "approval-required",
      snapshot: snapshot("full-access"),
      signal: new AbortController().signal,
      request,
      settleIntervalMs: 1,
    })).rejects.toThrow("kept thread mode full-access instead of approval-required");
    const unknown = harness([undefined]);
    await expect(ensureRuntimeThreadMode({
      sandbox: SANDBOX,
      threadId: THREAD,
      runtimeMode: "approval-required",
      snapshot: snapshot(undefined),
      signal: new AbortController().signal,
      request: unknown.request,
      settleIntervalMs: 1,
    })).rejects.toThrow("kept thread mode unknown");
  });

  test("against the pinned runtime's recorded behaviour, every mode transition reaches the turn only through the mode step", async () => {
    const transitions: Array<[RuntimeMode, "read-only" | "approval-required" | "full-access"]> = [
      ["full-access", "read-only"],
      ["full-access", "approval-required"],
      ["approval-required", "full-access"],
    ];
    for (const [threadMode, runMode] of transitions) {
      const wanted = runtimeModeFor(runMode);
      // The flaw round one recorded: the turn start's own mode changes nothing.
      const bare = recordedRuntime(threadMode);
      await bare.startTurn(wanted);
      expect(bare.turns).toEqual([threadMode]);
      // The adapter's step: set the thread, wait for the runtime to report it, then start the turn.
      const guarded = recordedRuntime(threadMode);
      const settled = await ensureRuntimeThreadMode({
        sandbox: SANDBOX,
        threadId: THREAD,
        runtimeMode: wanted,
        snapshot: snapshot(threadMode, 1),
        signal: new AbortController().signal,
        request: guarded.request,
        settleIntervalMs: 1,
      });
      expect(settled.thread.runtimeMode).toBe(wanted);
      await guarded.startTurn(wanted);
      expect(guarded.turns).toEqual([wanted]);
    }
  });
});
