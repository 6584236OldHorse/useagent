import { setTimeout as delay } from "node:timers/promises";
import type { SandboxHandle } from "../sandboxes/provider";
import { requestRuntimeEnvironment } from "./runtime-environment-client";
import type { RuntimeMode, RuntimeThreadSnapshot } from "./runtime-orchestration";

// The resident runtime applies a turn's permission mode from the THREAD it
// stores, not from the turn start command: a turn on an existing thread runs
// with whatever mode the thread was created with, and its provider reactor
// restarts the session only when the thread's mode differs from the session's.
// So a run whose mode differs from the thread's sets the thread's mode first
// and only proceeds once the runtime reports it; a thread that will not take
// the mode fails the turn rather than running wider than the run allows.

const MODE_SETTLE_ATTEMPTS = 20;
const MODE_SETTLE_INTERVAL_MS = 250;

/** The runtime command that sets a thread's mode ahead of a turn. */
export function buildRuntimeModeSetCommand(
  threadId: string,
  runtimeMode: RuntimeMode,
  createdAt = new Date().toISOString(),
): Readonly<Record<string, unknown>> {
  return {
    type: "thread.runtime-mode.set",
    commandId: `skynet-runtime-mode-${crypto.randomUUID()}`,
    threadId,
    runtimeMode,
    createdAt,
  };
}

export async function ensureRuntimeThreadMode(input: {
  readonly sandbox: SandboxHandle;
  readonly threadId: string;
  readonly runtimeMode: RuntimeMode;
  readonly snapshot: RuntimeThreadSnapshot;
  readonly signal: AbortSignal;
  readonly request?: typeof requestRuntimeEnvironment;
  readonly settleIntervalMs?: number;
}): Promise<RuntimeThreadSnapshot> {
  if (input.snapshot.thread.runtimeMode === input.runtimeMode) return input.snapshot;
  const request = input.request ?? requestRuntimeEnvironment;
  await request(
    input.sandbox,
    {
      method: "POST",
      path: "/api/orchestration/dispatch",
      payload: buildRuntimeModeSetCommand(input.threadId, input.runtimeMode),
    },
    input.signal,
  );
  let latest = input.snapshot;
  for (let attempt = 0; attempt < MODE_SETTLE_ATTEMPTS; attempt += 1) {
    latest = await request<RuntimeThreadSnapshot>(
      input.sandbox,
      { method: "GET", path: `/api/orchestration/threads/${encodeURIComponent(input.threadId)}` },
      input.signal,
    );
    if (latest.thread.runtimeMode === input.runtimeMode) return latest;
    await delay(input.settleIntervalMs ?? MODE_SETTLE_INTERVAL_MS, undefined, { signal: input.signal });
  }
  throw new Error(
    `the provider runtime kept thread mode ${latest.thread.runtimeMode ?? "unknown"} instead of ${input.runtimeMode}`,
  );
}
