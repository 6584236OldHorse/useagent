import { describe, expect, test } from "bun:test";
import type { PermissionMode } from "@useagent/agent-client/wire";
import { json } from "./helpers";
import { recordProviderEvent, threadHasSessionGrant } from "../src/runs/provider-events";
import { waitForRuntimeTurn } from "../src/engines/runtime-adapter";
import { replyToRuntimeApproval, type RuntimeApprovalReplyDependencies } from "../src/engines/runtime-approval";
import { assertReadOnlyTurnAllowed } from "../src/engines/runtime-thread-mode";
import { runtimeThreadId, type RuntimeThreadSnapshot } from "../src/engines/runtime-orchestration";
import type { RuntimeThreadStreamItem } from "../src/engines/runtime-event-stream";
import type { EmitStep, EngineRunContext } from "../src/engines/types";
import type { SandboxHandle } from "../src/sandboxes/provider";
import { createSecretRedactor } from "../src/secrets/redact";

// Enforcement per permission mode at the runtime adapter boundary, against a
// real accepted run so the projector's provider-event record lands. The
// runtime's own approval requests arrive as thread snapshots; a read-only run
// must decline every command and file change itself, a Guard run must leave
// them waiting for a person, and reads pass in both.

type Activity = RuntimeThreadSnapshot["thread"]["activities"][number];

async function acceptedRun(permissionMode: PermissionMode) {
  const { status, body } = await json<{ id: string }>("/api/runs", {
    method: "POST",
    body: { prompt: "look around", permission_mode: permissionMode },
  });
  expect(status).toBe(201);
  const { body: run } = await json<{ thread_id: string; permission_mode: string }>(`/api/runs/${body.id}`);
  expect(run.permission_mode).toBe(permissionMode);
  return { runId: body.id, threadId: run.thread_id };
}

function requested(requestId: string, requestKind: string): Activity {
  return {
    id: `activity-${requestId}`,
    tone: "approval",
    kind: "approval.requested",
    summary: "Approval requested",
    payload: { requestId, requestKind, detail: "rm -rf build" },
    turnId: "turn-1",
  };
}

function resolved(requestId: string): Activity {
  return {
    id: `activity-${requestId}-resolved`,
    tone: "approval",
    kind: "approval.resolved",
    summary: "Approval resolved",
    payload: { requestId, decision: "decline" },
    turnId: "turn-1",
  };
}

function snapshot(
  ctx: EngineRunContext,
  sequence: number,
  turnId: string,
  state: "running" | "completed",
  activities: Activity[],
): RuntimeThreadSnapshot {
  return {
    snapshotSequence: sequence,
    thread: {
      id: runtimeThreadId(ctx),
      latestTurn: { turnId, state, assistantMessageId: "assistant-1" },
      messages: [{ id: "assistant-1", role: "assistant", text: "Looked around.", turnId, streaming: state === "running" }],
      activities,
      session: null,
    },
  };
}

async function driveTurn(permissionMode: PermissionMode, requestKind: string) {
  const run = await acceptedRun(permissionMode);
  const steps: EmitStep[] = [];
  const replies: unknown[] = [];
  const ctx = {
    runId: run.runId,
    threadId: run.threadId,
    permissionMode,
    signal: new AbortController().signal,
    emit: async (step: EmitStep) => {
      steps.push(step);
      return undefined;
    },
    setSummary() {},
    publishDelta() {},
  } as unknown as EngineRunContext;
  const prior = snapshot(ctx, 10, "turn-prior", "completed", []);
  const subscribe = async (
    _sandbox: SandboxHandle,
    _threadId: string,
    _afterSequence: number | undefined,
    _signal: AbortSignal,
    onItem: (item: RuntimeThreadStreamItem) => Promise<boolean>,
  ) => {
    const request = requested("approval-1", requestKind);
    expect(await onItem({ kind: "snapshot", snapshot: snapshot(ctx, 11, "turn-1", "running", [request]) })).toBe(true);
    expect(await onItem({
      kind: "snapshot",
      snapshot: snapshot(ctx, 12, "turn-1", "completed", [request, resolved("approval-1")]),
    })).toBe(false);
  };
  const text = await waitForRuntimeTurn(
    ctx,
    {} as SandboxHandle,
    new Map(),
    prior,
    createSecretRedactor([]),
    {
      subscribeRuntimeThread: subscribe,
      readThreadSnapshot: async () => {
        throw new Error("unexpected REST snapshot read");
      },
      replyToRuntimeApproval: async (input) => {
        replies.push(input);
        return { alreadyAnswered: false };
      },
    },
  );
  return { ctx, text, steps, replies };
}

describe("permission mode enforcement in the runtime adapter", () => {
  test("a read-only run declines a file change through the reply path and records the refusal", async () => {
    const { ctx, text, steps, replies } = await driveTurn("read-only", "file-change");
    expect(text).toBe("Looked around.");
    expect(replies).toEqual([{
      runId: ctx.runId,
      threadId: ctx.threadId,
      sessionId: runtimeThreadId(ctx),
      requestId: "approval-1",
      decision: "decline",
      signal: ctx.signal,
      expectedSandbox: null,
      permissionMode: "read-only",
    }]);
    expect(steps.some((step) => step.label === "Refused to change files: this run is read-only" && step.chip === "read-only")).toBe(true);
  });

  test("a read-only run declines a command too, and only once per request", async () => {
    const { replies, steps } = await driveTurn("read-only", "command");
    expect(replies).toHaveLength(1);
    expect(steps.filter((step) => step.chip === "read-only").map((step) => step.label)).toEqual([
      "Refused to run a command: this run is read-only",
    ]);
  });

  test("a read-only run lets a file read wait for the person instead of refusing it", async () => {
    const { replies, steps } = await driveTurn("read-only", "file-read");
    expect(replies).toEqual([]);
    expect(steps.some((step) => step.chip === "read-only")).toBe(false);
  });

  test("a Guard run leaves an edit waiting for the person; nothing is answered on its behalf", async () => {
    const { replies, steps } = await driveTurn("approval-required", "file-change");
    expect(replies).toEqual([]);
    expect(steps.some((step) => step.chip === "read-only")).toBe(false);
  });

  /** The reply path against a fake runtime holding one pending command request,
   *  with the ledger writes routed through `recordEvent`. */
  function grantHarness(run: { runId: string; threadId: string }, options: { readonly loseReceipt: boolean }) {
    const sessionId = runtimeThreadId({ runId: run.runId, threadId: run.threadId });
    const log: string[] = [];
    const pendingSnapshot = (): RuntimeThreadSnapshot => ({
      snapshotSequence: 3,
      thread: {
        id: sessionId,
        latestTurn: { turnId: "turn-1", state: "running", assistantMessageId: null },
        messages: [],
        activities: [requested("approval-1", "command")],
        session: null,
      },
    });
    const dependencies: Partial<RuntimeApprovalReplyDependencies> = {
      resolveSandbox: async () => ({} as SandboxHandle),
      request: (async (_sandbox: SandboxHandle, req: { method: string; payload?: unknown }) => {
        if (req.method === "GET") return pendingSnapshot();
        log.push(`dispatch:${(req.payload as { decision?: string }).decision}`);
        return {};
      }) as unknown as RuntimeApprovalReplyDependencies["request"],
      recordEvent: (async (input, opts) => {
        if (options.loseReceipt && input.eventType === "approval.responded") throw new Error("ledger unavailable");
        log.push(`record:${input.eventType}`);
        return recordProviderEvent(input, opts);
      }) as RuntimeApprovalReplyDependencies["recordEvent"],
    };
    const reply = (decision: "accept" | "acceptForSession") => replyToRuntimeApproval({
      runId: run.runId,
      threadId: run.threadId,
      sessionId,
      requestId: "approval-1",
      decision,
      signal: new AbortController().signal,
      expectedSandbox: null,
      permissionMode: "approval-required",
    }, dependencies);
    return { log, reply };
  }

  test("a session grant is durable before the runtime sees it, so a lost receipt still keeps read only off that thread", async () => {
    const run = await acceptedRun("approval-required");
    expect(await threadHasSessionGrant(run.threadId)).toBe(false);
    const { log, reply } = grantHarness(run, { loseReceipt: true });
    await expect(reply("acceptForSession")).rejects.toThrow("ledger unavailable");
    // The intent landed before the grant was dispatched; the receipt never did.
    expect(log).toEqual(["record:approval.responding", "dispatch:acceptForSession"]);
    expect(await threadHasSessionGrant(run.threadId)).toBe(true);
    await expect(assertReadOnlyTurnAllowed({ threadId: run.threadId, permissionMode: "read-only", threadExists: true }))
      .rejects.toThrow("remembers approvals");
    // Other modes, and a thread the runtime has not created yet, are not held back by it.
    await assertReadOnlyTurnAllowed({ threadId: run.threadId, permissionMode: "approval-required", threadExists: true });
    await assertReadOnlyTurnAllowed({ threadId: run.threadId, permissionMode: "read-only", threadExists: false });
  });

  test("a confirmed session grant keeps read only off the thread; a plain accept does not", async () => {
    const granted = await acceptedRun("approval-required");
    const grant = grantHarness(granted, { loseReceipt: false });
    await expect(grant.reply("acceptForSession")).resolves.toEqual({ alreadyAnswered: false });
    expect(grant.log).toEqual(["record:approval.responding", "dispatch:acceptForSession", "record:approval.responded"]);
    await expect(assertReadOnlyTurnAllowed({ threadId: granted.threadId, permissionMode: "read-only", threadExists: true }))
      .rejects.toThrow("remembers approvals");

    const plain = await acceptedRun("approval-required");
    const once = grantHarness(plain, { loseReceipt: false });
    await expect(once.reply("accept")).resolves.toEqual({ alreadyAnswered: false });
    expect(once.log).toEqual(["dispatch:accept", "record:approval.responded"]);
    expect(await threadHasSessionGrant(plain.threadId)).toBe(false);
    await assertReadOnlyTurnAllowed({ threadId: plain.threadId, permissionMode: "read-only", threadExists: true });
  });
});
