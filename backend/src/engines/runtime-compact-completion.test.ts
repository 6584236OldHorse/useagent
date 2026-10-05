import { expect, test } from "bun:test";
import { createSecretRedactor } from "../secrets/redact";
import type { ProviderEventInput } from "../runs/provider-events";
import type { SandboxHandle } from "../sandboxes/provider";
import {
  waitForRuntimeCompact,
} from "./runtime-compact-completion";
import {
  COMPACT_STOPPED_WAITING_SUMMARY,
  COMPACT_TIMED_OUT_WAITING_SUMMARY,
  RUNTIME_COMPACT_TIMEOUT_MS,
  compactWaitTerminationSummary,
} from "./runtime-compact-contract";
import {
  buildRuntimeTurnStartCommand,
  runtimeUserMessageId,
  type RuntimeActivity,
  type RuntimeThreadSnapshot,
} from "./runtime-orchestration";
import type { RuntimeThreadStreamItem } from "./runtime-event-stream";
import type { EngineRunContext } from "./types";

const RUN_ID = "run-compact";
const THREAD_ID = "skynet-thread-thread-1";
const REQUEST_ID = runtimeUserMessageId(RUN_ID);

function activity(
  kind: string,
  requestId: string,
  payload: Readonly<Record<string, unknown>> = {},
): RuntimeActivity {
  return {
    id: `${kind}-${requestId}`,
    tone: kind === "provider.turn.start.failed" ? "error" : "info",
    kind,
    summary: kind === "context-compaction" ? "Context compacted" : "Compaction failed",
    payload: { requestId, ...payload },
    turnId: null,
  };
}

function snapshot(
  sequence: number,
  activities: readonly RuntimeActivity[],
  sessionStatus = "starting",
): RuntimeThreadSnapshot {
  return {
    snapshotSequence: sequence,
    thread: {
      id: THREAD_ID,
      latestTurn: {
        turnId: "prior-turn",
        state: "completed",
        assistantMessageId: "prior-assistant",
      },
      messages: [],
      activities,
      session: { status: sessionStatus, lastError: null },
    },
  };
}

function context(signal = new AbortController().signal): EngineRunContext {
  return {
    runId: RUN_ID,
    threadId: "thread-1",
    signal,
    emit: async () => undefined,
    setSummary() {},
  } as unknown as EngineRunContext;
}

function dependencies(input: {
  subscribe: (
    signal: AbortSignal,
    onItem: (item: RuntimeThreadStreamItem) => Promise<boolean>,
  ) => Promise<void>;
  captured?: ProviderEventInput[];
  readSnapshot?: () => Promise<RuntimeThreadSnapshot>;
}) {
  return {
    readThreadSnapshot: input.readSnapshot ?? (async () => { throw new Error("unexpected snapshot read"); }),
    subscribeRuntimeThread: async (
      _sandbox: SandboxHandle,
      _threadId: string,
      _after: number | undefined,
      signal: AbortSignal,
      onItem: (item: RuntimeThreadStreamItem) => Promise<boolean>,
    ) => input.subscribe(signal, onItem),
    recordProviderEvent: async (event: ProviderEventInput) => {
      input.captured?.push(event);
    },
  };
}

test("compact dispatch and completion use the same accepted message identity", () => {
  const command = buildRuntimeTurnStartCommand(
    { runId: RUN_ID, threadId: "thread-1" },
    "codex",
    "/compact",
    "2026-09-14T00:00:00.000Z",
    false,
  );

  expect(command).toMatchObject({
    type: "thread.turn.start",
    message: { messageId: REQUEST_ID, text: "/compact" },
  });
});

test("Stop and timeout say only that useAgent stopped waiting", () => {
  expect(RUNTIME_COMPACT_TIMEOUT_MS).toBe(600_000);
  expect(compactWaitTerminationSummary("compact", true, false, new Error("cancelled")))
    .toBe(COMPACT_STOPPED_WAITING_SUMMARY);
  expect(compactWaitTerminationSummary("compact", false, true, new Error("timeout")))
    .toBe(COMPACT_TIMED_OUT_WAITING_SUMMARY);
  expect(compactWaitTerminationSummary(
    "compact",
    false,
    false,
    new Error(COMPACT_TIMED_OUT_WAITING_SUMMARY),
  )).toBe(COMPACT_TIMED_OUT_WAITING_SUMMARY);
  expect(compactWaitTerminationSummary("review", true, false, new Error("cancelled"))).toBeNull();
});

test("compact completes from its exact request activity while latestTurn stays unchanged", async () => {
  const captured: ProviderEventInput[] = [];
  const unrelated = activity("context-compaction", "another-request", { state: "compacted" });
  const completed = activity("context-compaction", REQUEST_ID, {
    state: "compacted",
    beforeTokens: 1000,
    afterTokens: 400,
  });

  await expect(waitForRuntimeCompact(
    context(),
    {} as SandboxHandle,
    snapshot(1, []),
    createSecretRedactor([]),
    REQUEST_ID,
    dependencies({
      captured,
      subscribe: async (_signal, onItem) => {
        expect(await onItem({ kind: "snapshot", snapshot: snapshot(2, [unrelated]) })).toBe(true);
        expect(await onItem({ kind: "snapshot", snapshot: snapshot(3, [unrelated, completed]) })).toBe(false);
      },
    }),
  )).resolves.toBe("Compacted");
  expect(captured).toHaveLength(1);
  expect(captured[0]).toMatchObject({
    eventType: "t3.activity.context-compaction",
    nativeSessionId: THREAD_ID,
  });
});

test("an unrelated compact activity is not completion", async () => {
  await expect(waitForRuntimeCompact(
    context(),
    {} as SandboxHandle,
    snapshot(1, []),
    createSecretRedactor([]),
    REQUEST_ID,
    dependencies({
      subscribe: async (_signal, onItem) => {
        expect(await onItem({
          kind: "snapshot",
          snapshot: snapshot(2, [activity("context-compaction", "other", { state: "compacted" })]),
        })).toBe(true);
      },
    }),
  )).rejects.toThrow("subscription ended before a terminal snapshot");
});

test("an event-only notification refreshes the authoritative compact snapshot", async () => {
  const completed = activity("context-compaction", REQUEST_ID, { state: "compacted" });
  let reads = 0;
  await expect(waitForRuntimeCompact(
    context(),
    {} as SandboxHandle,
    snapshot(1, []),
    createSecretRedactor([]),
    REQUEST_ID,
    dependencies({
      readSnapshot: async () => {
        reads += 1;
        return snapshot(2, [completed]);
      },
      subscribe: async (signal, onItem) => {
        expect(await onItem({
          kind: "event",
          event: { sequence: 2, aggregateKind: "thread", aggregateId: THREAD_ID },
        })).toBe(true);
        if (!signal.aborted) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        }
      },
    }),
  )).resolves.toBe("Compacted");
  expect(reads).toBe(1);
});

test("a slow compact may remain starting without entering ordinary turn-start recovery", async () => {
  const completed = activity("context-compaction", REQUEST_ID, { state: "compacted" });
  await expect(waitForRuntimeCompact(
    context(),
    {} as SandboxHandle,
    snapshot(1, []),
    createSecretRedactor([]),
    REQUEST_ID,
    dependencies({
      subscribe: async (_signal, onItem) => {
        expect(await onItem({ kind: "snapshot", snapshot: snapshot(2, []) })).toBe(true);
        expect(await onItem({ kind: "snapshot", snapshot: snapshot(3, []) })).toBe(true);
        expect(await onItem({ kind: "snapshot", snapshot: snapshot(4, [completed]) })).toBe(false);
      },
    }),
  )).resolves.toBe("Compacted");
});

test("compact cancellation preserves the caller's abort reason", async () => {
  const controller = new AbortController();
  const reason = new Error("compact cancelled");
  const waiting = waitForRuntimeCompact(
    context(controller.signal),
    {} as SandboxHandle,
    snapshot(1, []),
    createSecretRedactor([]),
    REQUEST_ID,
    dependencies({
      subscribe: async (signal) => {
        if (!signal.aborted) {
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        }
      },
    }),
  );

  controller.abort(reason);
  await expect(waiting).rejects.toBe(reason);
});

test("a correlated provider compact failure stays a failure", async () => {
  await expect(waitForRuntimeCompact(
    context(),
    {} as SandboxHandle,
    snapshot(1, []),
    createSecretRedactor([]),
    REQUEST_ID,
    dependencies({
      subscribe: async (_signal, onItem) => {
        expect(await onItem({
          kind: "snapshot",
          snapshot: snapshot(2, [activity("provider.turn.start.failed", REQUEST_ID, { detail: "Context limit unavailable" })]),
        })).toBe(false);
      },
    }),
  )).rejects.toThrow("Context limit unavailable");
});
