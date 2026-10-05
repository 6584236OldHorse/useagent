import type { PermissionMode } from "@useagent/agent-client/wire";
import { setTimeout as delay } from "node:timers/promises";
import { threadHasSessionGrant } from "../runs/provider-events";
import type { SandboxHandle } from "../sandboxes/provider";
import { requestRuntimeEnvironment, runtimeThreadSnapshotRequest } from "./runtime-environment-client";
import type { RuntimeMode, RuntimeThreadSnapshot } from "./runtime-orchestration";

/**
 * A grant answered "always allow this session" outlives a mode change on the
 * provider session, and the runtime offers no way to take it back, so a
 * read-only turn cannot be enforced on a thread that may hold one. The thread
 * is refused, visibly, before its turn starts. "May hold one" is read from our
 * own durable records: the intent written before a grant is dispatched and the
 * receipt written after; an intent whose receipt never landed counts too.
 */
export async function assertReadOnlyTurnAllowed(input: {
  readonly threadId: string;
  readonly permissionMode: PermissionMode | undefined;
  readonly threadExists: boolean;
  readonly hasSessionGrant?: typeof threadHasSessionGrant;
}): Promise<void> {
  if (!input.threadExists || input.permissionMode !== "read-only") return;
  if (await (input.hasSessionGrant ?? threadHasSessionGrant)(input.threadId)) {
    throw new Error(
      "This thread remembers approvals for its session, so read only cannot be enforced on it. Start a new thread for read-only work.",
    );
  }
}

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
      runtimeThreadSnapshotRequest(input.threadId),
      input.signal,
    );
    if (latest.thread.runtimeMode === input.runtimeMode) return latest;
    await delay(input.settleIntervalMs ?? MODE_SETTLE_INTERVAL_MS, undefined, { signal: input.signal });
  }
  throw new Error(
    `the provider runtime kept thread mode ${latest.thread.runtimeMode ?? "unknown"} instead of ${input.runtimeMode}`,
  );
}
