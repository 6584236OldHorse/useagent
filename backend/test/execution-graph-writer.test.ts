import { afterAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { NativeBridgeSequencer } from "@useagent/agent-harness/bridge";
import * as schema from "../src/db/schema";
import {
  agentExecutions,
  delegationEdges,
  executionGraphPendingObservations,
  providerEvents,
  runs,
} from "../src/db/schema";
import { piBridgeProviderEvent } from "../src/engines/pi-provider-events";
import { executionGraphEnabled } from "../src/runs/execution-graph-switch";
import {
  executionGraphObservationKind,
  writeExecutionGraph,
} from "../src/runs/execution-graph-writer";
import type { ProviderEventInput } from "../src/runs/provider-events";
import { subscribeOrg } from "../src/runs/org-signals";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost:5432/postgres";
const databaseName = `useagent_graph_shadow_${crypto.randomUUID().replaceAll("-", "")}`;
const testUrl = new URL(ADMIN_URL);
testUrl.pathname = `/${databaseName}`;

const admin = postgres(ADMIN_URL, { max: 1 });
await admin.unsafe(`create database "${databaseName}"`);
const client = postgres(testUrl.toString(), { max: 2 });
const testDb = drizzle(client, { schema });
await migrate(testDb, { migrationsFolder: `${import.meta.dir}/../drizzle` });

afterAll(async () => {
  await client.end();
  await admin.unsafe(`drop database if exists "${databaseName}"`);
  await admin.end();
});

async function seedRun(orgId: string): Promise<string> {
  const runId = crypto.randomUUID();
  await testDb.insert(runs).values({
    id: runId,
    orgId,
    prompt: "shadow graph fixture",
    model: "mock",
    engine: "mock",
    status: "queued",
    parentRunId: null,
    threadId: runId,
  });
  return runId;
}

/** Production invokes the graph writer only after provider-event durability.
 * Keep the focused writer tests on that real boundary. */
async function writeProviderEventAndGraph(
  input: ProviderEventInput,
  deliverySeq: number,
  exec = testDb,
): Promise<void> {
  let payload: string | null = null;
  if (input.payload !== undefined) {
    try {
      payload = JSON.stringify(input.payload);
    } catch {
      payload = null;
    }
  }
  await exec.insert(providerEvents).values({
    id: input.id,
    runId: input.runId,
    threadId: input.threadId,
    seq: deliverySeq,
    provider: input.provider,
    eventType: input.eventType,
    nativeSessionId: input.nativeSessionId ?? null,
    nativeParentSessionId: input.nativeParentSessionId ?? null,
    nativeMessageId: input.nativeMessageId ?? null,
    nativePartId: input.nativePartId ?? null,
    nativeCallId: input.nativeCallId ?? null,
    payload,
  }).onConflictDoUpdate({
    target: providerEvents.id,
    set: {
      seq: deliverySeq,
      provider: input.provider,
      eventType: input.eventType,
      nativeSessionId: input.nativeSessionId ?? null,
      nativeParentSessionId: input.nativeParentSessionId ?? null,
      nativeMessageId: input.nativeMessageId ?? null,
      nativePartId: input.nativePartId ?? null,
      nativeCallId: input.nativeCallId ?? null,
      payload,
    },
  });
  await writeExecutionGraph(input, deliverySeq, exec);
}

describe("execution graph writer", () => {
  test("the writer is on by default and off only behind the kill switch", () => {
    expect(executionGraphEnabled({})).toBe(true);
    expect(executionGraphEnabled({ EXECUTION_GRAPH_ROLLOUT: "off" })).toBe(false);
    expect(executionGraphEnabled({ EXECUTION_GRAPH_ROLLOUT: "shadow" })).toBe(true);
    expect(executionGraphEnabled({ EXECUTION_GRAPH_ROLLOUT: "read" })).toBe(true);
  });

  test("classifies only graph-semantic events before any database lookup", () => {
    const base = {
      id: "event",
      runId: "run",
      threadId: "run",
      provider: "t3",
      nativeSessionId: "root",
    } as const;
    expect(executionGraphObservationKind({
      ...base,
      eventType: "t3.activity.message.delta",
      payload: { kind: "message.delta", payload: { text: "hello" } },
    })).toBeNull();
    expect(executionGraphObservationKind({
      ...base,
      eventType: "t3.activity.tool.completed",
      payload: { kind: "tool.completed", payload: { toolName: "bash" } },
    })).toBeNull();
    expect(executionGraphObservationKind({
      ...base,
      eventType: "t3.activity.task.completed",
      nativeSessionId: "child",
      nativeParentSessionId: "root",
      payload: {
        kind: "task.completed",
        payload: { taskId: "child", parentAgentId: "root", agentKind: "agent" },
      },
    })).toBe("lifecycle");
    expect(executionGraphObservationKind({
      ...base,
      eventType: "t3.activity.tool.completed",
      payload: {
        kind: "tool.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          delegationKind: "wait",
          detail: '<task id="child-from-wait" state="completed"></task>',
        },
      },
    })).toBe("control");
  });

  test("writes only explicit OpenCode root and parent-linked child identities", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    const changes: unknown[] = [];
    const unsubscribe = subscribeOrg(orgId, (change) => changes.push(change));
    await writeProviderEventAndGraph({
      id: `${runId}:root:session`,
      runId,
      threadId: runId,
      provider: "opencode",
      eventType: "session.started",
      nativeSessionId: "root-session",
    }, 0, testDb);
    await writeProviderEventAndGraph({
      id: `${runId}:child:session`,
      runId,
      threadId: runId,
      provider: "opencode",
      eventType: "session.created",
      nativeSessionId: "child-session",
      nativeParentSessionId: "root-session",
    }, 1, testDb);
    expect(changes).toContainEqual({
      type: "execution_graph",
      runId,
      threadId: runId,
      graphCursor: 1,
    });
    unsubscribe();
    await writeProviderEventAndGraph({
      id: `${runId}:task-wrapper`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.tool.started",
      nativeSessionId: "parent",
      nativeCallId: "wrapper-call",
      payload: {
        kind: "tool.started",
        payload: {
          itemType: "collab_agent_tool_call",
          delegationKind: "spawn",
          childSessionId: "child",
          toolUseId: "wrapper-call",
        },
      },
    }, 2, testDb);
    await writeProviderEventAndGraph({
      id: `${runId}:resume-control-started`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.tool.started",
      nativeSessionId: "parent",
      nativeCallId: "resume-call",
      payload: {
        kind: "tool.started",
        payload: {
          itemType: "collab_agent_tool_call",
          delegationKind: "resume",
          childSessionId: "child",
          toolUseId: "resume-call",
        },
      },
    }, 3, testDb);
    await writeProviderEventAndGraph({
      id: `${runId}:ambiguous-child`,
      runId,
      threadId: runId,
      provider: "opencode",
      eventType: "session.updated",
      nativeSessionId: "ambiguous-child",
    }, 4, testDb);

    const executions = await testDb.select().from(agentExecutions).where(and(
      eq(agentExecutions.orgId, orgId),
      eq(agentExecutions.runId, runId),
    ));
    expect(executions).toHaveLength(2);
    expect(executions.map((row) => [row.mode, row.nativeSessionId]).sort()).toEqual([
      ["native_child", "child-session"],
      ["root", "root-session"],
    ]);
    expect(await testDb.select().from(delegationEdges).where(
      eq(delegationEdges.runId, runId),
    )).toHaveLength(1);
  });

  test("attaches live Codex children to the unique root when provider parent identity differs", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    await writeProviderEventAndGraph({
      id: `${runId}:root`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "session.started",
      nativeSessionId: `product-thread-${runId}`,
    }, 0, testDb);
    await writeProviderEventAndGraph({
      id: `${runId}:child-started`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.task.started",
      nativeSessionId: "provider-child-a",
      nativeParentSessionId: "provider-parent-thread",
      nativeCallId: "provider-child-a",
      payload: {
        kind: "task.started",
        payload: {
          taskId: "provider-child-a",
          parentAgentId: "provider-parent-thread",
          agentKind: "agent",
          title: "calc_a",
          agentPath: "/root/calc_a",
        },
      },
    }, 1, testDb);

    const executions = await testDb.select().from(agentExecutions).where(
      eq(agentExecutions.runId, runId),
    );
    const root = executions.find((row) => row.mode === "root");
    const child = executions.find((row) => row.mode === "native_child");
    expect(root?.nativeSessionId).toBe(`product-thread-${runId}`);
    expect(child).toMatchObject({
      nativeSessionId: "provider-child-a",
      nativeParentSessionId: "provider-parent-thread",
      status: "running",
    });
    expect(await testDb.select().from(delegationEdges).where(
      eq(delegationEdges.runId, runId),
    )).toEqual([
      expect.objectContaining({
        parentExecutionId: root?.id,
        childExecutionId: child?.id,
        kind: "spawn",
      }),
    ]);
  });

  test("never mis-parents a reversed nested child to the root", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    await writeProviderEventAndGraph({
      id: `${runId}:root`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "session.started",
      nativeSessionId: `product-thread-${runId}`,
    }, 0, testDb);
    await writeProviderEventAndGraph({
      id: `${runId}:nested-before-parent`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.task.started",
      nativeSessionId: "provider-child-b",
      nativeParentSessionId: "provider-child-a",
      payload: {
        kind: "task.started",
        payload: {
          taskId: "provider-child-b",
          parentAgentId: "provider-child-a",
          agentKind: "agent",
          agentPath: "/root/calc_a/nested_b",
        },
      },
    }, 1, testDb);
    expect(await testDb.select().from(agentExecutions).where(and(
      eq(agentExecutions.runId, runId),
      eq(agentExecutions.mode, "native_child"),
    ))).toEqual([]);
    expect(await testDb.select().from(delegationEdges).where(
      eq(delegationEdges.runId, runId),
    )).toEqual([]);
  });

  test("recovers exact nested ancestry when the missing parent arrives later", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    await writeProviderEventAndGraph({
      id: `${runId}:root`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "session.started",
      nativeSessionId: `product-thread-${runId}`,
    }, 0, testDb);
    await writeProviderEventAndGraph({
      id: `${runId}:nested-before-parent`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.task.started",
      nativeSessionId: "provider-child-b",
      nativeParentSessionId: "provider-child-a",
      payload: {
        kind: "task.started",
        payload: {
          taskId: "provider-child-b",
          parentAgentId: "provider-child-a",
          agentKind: "agent",
          agentPath: "/root/calc_a/nested_b",
        },
      },
    }, 1, testDb);
    expect(await testDb.select().from(executionGraphPendingObservations).where(
      eq(executionGraphPendingObservations.runId, runId),
    )).toEqual([
      expect.objectContaining({
        latestNativeParentSessionId: "provider-child-a",
        latestNativeChildSessionId: "provider-child-b",
        resolvedAt: null,
      }),
    ]);

    await writeProviderEventAndGraph({
      id: `${runId}:parent-arrives`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.task.started",
      nativeSessionId: "provider-child-a",
      nativeParentSessionId: "provider-parent-thread",
      payload: {
        kind: "task.started",
        payload: {
          taskId: "provider-child-a",
          parentAgentId: "provider-parent-thread",
          agentKind: "agent",
          agentPath: "/root/calc_a",
        },
      },
    }, 2, testDb);

    const executions = await testDb.select().from(agentExecutions).where(
      eq(agentExecutions.runId, runId),
    );
    const childA = executions.find((row) => row.nativeSessionId === "provider-child-a");
    const childB = executions.find((row) => row.nativeSessionId === "provider-child-b");
    expect(childA?.mode).toBe("native_child");
    expect(childB).toMatchObject({
      mode: "native_child",
      nativeParentSessionId: "provider-child-a",
    });
    expect((await testDb.select().from(delegationEdges).where(
      eq(delegationEdges.runId, runId),
    )).map((row) => [row.parentExecutionId, row.childExecutionId])).toContainEqual([
      childA?.id,
      childB?.id,
    ]);
    expect(await testDb.select().from(executionGraphPendingObservations).where(
      eq(executionGraphPendingObservations.runId, runId),
    )).toEqual([
      expect.objectContaining({
        resolutionReason: "applied",
        appliedStructureHash: expect.stringMatching(/^v1:/),
      }),
      expect.objectContaining({
        resolutionReason: "applied",
        appliedStructureHash: expect.stringMatching(/^v1:/),
      }),
    ]);
  });

  test("reaches a fixed point when grandchild, child, then root arrive in reverse dependency order", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    const task = (id: string, parent: string, path: string) => ({
      id: `${runId}:${id}`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.task.started",
      nativeSessionId: id,
      nativeParentSessionId: parent,
      payload: {
        kind: "task.started",
        payload: { taskId: id, parentAgentId: parent, agentKind: "agent", agentPath: path },
      },
    } as const);
    await writeProviderEventAndGraph(task("child-b", "child-a", "/root/a/b"), 1, testDb);
    await writeProviderEventAndGraph(task("child-a", "root", "/root/a"), 2, testDb);
    await writeProviderEventAndGraph({
      id: `${runId}:root`, runId, threadId: runId, provider: "t3",
      eventType: "session.started", nativeSessionId: "root",
    }, 3, testDb);
    const executions = await testDb.select().from(agentExecutions).where(
      eq(agentExecutions.runId, runId),
    );
    const byNative = new Map(executions.map((row) => [row.nativeSessionId, row]));
    expect(byNative.get("child-b")?.nativeParentSessionId).toBe("child-a");
    expect(await testDb.select().from(executionGraphPendingObservations).where(and(
      eq(executionGraphPendingObservations.runId, runId),
      eq(executionGraphPendingObservations.resolutionReason, "applied"),
    ))).toHaveLength(2);
  });

  test("replays a terminal lifecycle that arrived before its spawn", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    await writeProviderEventAndGraph({
      id: `${runId}:root`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "session.started",
      nativeSessionId: "parent",
    }, 0, testDb);
    await writeProviderEventAndGraph({
      id: `${runId}:terminal-before-spawn`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.task.completed",
      nativeSessionId: "child",
      nativeParentSessionId: "parent",
      payload: {
        kind: "task.completed",
        payload: { taskId: "child", parentAgentId: "parent", agentKind: "agent", status: "completed" },
      },
    }, 1, testDb);
    await writeProviderEventAndGraph({
      id: `${runId}:spawn`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.task.started",
      nativeSessionId: "child",
      nativeParentSessionId: "parent",
      payload: {
        kind: "task.started",
        payload: { taskId: "child", parentAgentId: "parent", agentKind: "agent", status: "running" },
      },
    }, 2, testDb);
    const [child] = await testDb.select().from(agentExecutions).where(and(
      eq(agentExecutions.runId, runId),
      eq(agentExecutions.nativeSessionId, "child"),
    ));
    expect(child).toMatchObject({
      status: "completed",
      lastEventId: `${runId}:terminal-before-spawn`,
      lastDeliverySeq: 2,
    });
  });

  test("persists edge-only control with an unknown target and never rewrites the child FK", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    await writeProviderEventAndGraph({
      id: `${runId}:root`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "session.started",
      nativeSessionId: "parent",
    }, 0, testDb);
    await writeProviderEventAndGraph({
      id: `${runId}:wait`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.tool.completed",
      nativeSessionId: "parent",
      nativeCallId: "wait-call",
      payload: {
        kind: "tool.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          delegationKind: "wait",
          receiverThreadIds: ["future-child"],
          toolUseId: "wait-call",
        },
      },
    }, 1, testDb);
    const [before] = await testDb.select().from(delegationEdges).where(
      eq(delegationEdges.runId, runId),
    );
    expect(before).toMatchObject({
      childExecutionId: null,
      nativeTargetSessionId: "future-child",
      kind: "wait",
    });
    await writeProviderEventAndGraph({
      id: `${runId}:future-child`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.task.started",
      nativeSessionId: "future-child",
      nativeParentSessionId: "parent",
      payload: {
        kind: "task.started",
        payload: { taskId: "future-child", parentAgentId: "parent", agentKind: "agent" },
      },
    }, 2, testDb);
    const [after] = await testDb.select().from(delegationEdges).where(
      eq(delegationEdges.id, before!.id),
    );
    expect(after).toMatchObject({
      id: before?.id,
      childExecutionId: null,
      nativeTargetSessionId: "future-child",
    });
  });

  test("a multi-target wait converges across early completion, later spawn, and stable replay", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    const base = { runId, threadId: runId, provider: "t3" } as const;
    await writeProviderEventAndGraph({
      ...base,
      id: `${runId}:root`,
      eventType: "session.started",
      nativeSessionId: "parent",
    }, 0, testDb);
    await writeProviderEventAndGraph({
      ...base,
      id: `${runId}:beta-complete-early`,
      eventType: "t3.activity.task.completed",
      nativeSessionId: "beta",
      nativeParentSessionId: "parent",
      payload: {
        kind: "task.completed",
        payload: { taskId: "beta", parentAgentId: "parent", agentKind: "agent" },
      },
    }, 1, testDb);
    await writeProviderEventAndGraph({
      ...base,
      id: `${runId}:spawn-alpha`,
      eventType: "t3.activity.task.started",
      nativeSessionId: "alpha",
      nativeParentSessionId: "parent",
      payload: {
        kind: "task.started",
        payload: { taskId: "alpha", parentAgentId: "parent", agentKind: "agent" },
      },
    }, 2, testDb);
    const wait = {
      ...base,
      id: `${runId}:wait-all`,
      eventType: "t3.activity.tool.completed",
      nativeSessionId: "parent",
      nativeCallId: "wait-all",
      payload: {
        kind: "tool.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          delegationKind: "wait",
          toolUseId: "wait-all",
          receiverThreadIds: ["alpha", "beta", "ghost"],
        },
      },
    } as const;
    await writeProviderEventAndGraph(wait, 3, testDb);
    const spawnBeta = {
      ...base,
      id: `${runId}:spawn-beta`,
      eventType: "t3.activity.task.started",
      nativeSessionId: "beta",
      nativeParentSessionId: "parent",
      payload: {
        kind: "task.started",
        payload: { taskId: "beta", parentAgentId: "parent", agentKind: "agent" },
      },
    } as const;
    await writeProviderEventAndGraph(spawnBeta, 4, testDb);
    await writeProviderEventAndGraph({
      ...spawnBeta,
      payload: { ...spawnBeta.payload, fixtureRevision: 2 },
    }, 5, testDb);
    await writeProviderEventAndGraph(wait, 6, testDb);

    const executions = await testDb.select().from(agentExecutions).where(
      eq(agentExecutions.runId, runId),
    );
    const executionBySession = new Map(executions.map((row) => [row.nativeSessionId, row]));
    const waitEdges = (await testDb.select().from(delegationEdges).where(and(
      eq(delegationEdges.runId, runId),
      eq(delegationEdges.kind, "wait"),
    ))).toSorted((left, right) =>
      (left.nativeTargetSessionId ?? "").localeCompare(right.nativeTargetSessionId ?? "")
    );
    expect(waitEdges).toHaveLength(3);
    expect(waitEdges.map((edge) => edge.sourceKey)).toEqual([
      `edge:t3:wait:wait-all:alpha`,
      `edge:t3:wait:wait-all:beta`,
      `edge:t3:wait:wait-all:ghost`,
    ]);
    expect(waitEdges.map((edge) => [edge.nativeTargetSessionId, edge.childExecutionId])).toEqual([
      ["alpha", executionBySession.get("alpha")?.id],
      ["beta", executionBySession.get("beta")?.id],
      ["ghost", null],
    ]);
    expect(executionBySession.get("beta")).toMatchObject({ status: "completed" });
  });

  test("treats a post-apply control target revision as structural mismatch", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    await writeProviderEventAndGraph({
      id: `${runId}:root`, runId, threadId: runId, provider: "t3",
      eventType: "session.started", nativeSessionId: "parent",
    }, 0, testDb);
    const eventId = `${runId}:wait`;
    const control = (target: string) => ({
      id: eventId,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.tool.completed",
      nativeSessionId: "parent",
      nativeCallId: "wait-call",
      payload: {
        kind: "tool.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          delegationKind: "wait",
          receiverThreadIds: [target],
          toolUseId: "wait-call",
        },
      },
    } as const);
    await writeProviderEventAndGraph(control("child-a"), 1, testDb);
    await writeProviderEventAndGraph(control("child-b"), 2, testDb);
    expect(await testDb.select().from(delegationEdges).where(
      eq(delegationEdges.runId, runId),
    )).toEqual([
      expect.objectContaining({ nativeTargetSessionId: "child-a" }),
    ]);
    expect(await testDb.select().from(executionGraphPendingObservations).where(
      eq(executionGraphPendingObservations.providerEventId, eventId),
    )).toEqual([
      expect.objectContaining({
        latestProviderEventSeq: 2,
        structuralMismatchCode: "applied_structure_changed",
      }),
    ]);
  });

  test("recovers a control whose exact parent execution arrived late", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    await writeProviderEventAndGraph({
      id: `${runId}:root`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "session.started",
      nativeSessionId: "root",
    }, 0, testDb);
    await writeProviderEventAndGraph({
      id: `${runId}:late-control`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.tool.completed",
      nativeSessionId: "late-parent",
      nativeCallId: "close-call",
      payload: {
        kind: "tool.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          delegationKind: "close",
          receiverThreadIds: ["target"],
          toolUseId: "close-call",
        },
      },
    }, 1, testDb);
    expect(await testDb.select().from(delegationEdges).where(
      eq(delegationEdges.runId, runId),
    )).toEqual([]);
    await writeProviderEventAndGraph({
      id: `${runId}:late-parent`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.task.started",
      nativeSessionId: "late-parent",
      nativeParentSessionId: "root",
      payload: {
        kind: "task.started",
        payload: { taskId: "late-parent", parentAgentId: "root", agentKind: "agent" },
      },
    }, 2, testDb);
    expect(await testDb.select().from(delegationEdges).where(
      eq(delegationEdges.runId, runId),
    )).toEqual([
      expect.objectContaining({ kind: "spawn", nativeTargetSessionId: "late-parent" }),
      expect.objectContaining({ kind: "close", nativeTargetSessionId: "target" }),
    ]);
  });

  test("recovers an OpenCode child identity from a completed task receipt", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    await writeProviderEventAndGraph({
      id: `${runId}:root`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "session.started",
      nativeSessionId: `product-thread-${runId}`,
    }, 0, testDb);
    await writeProviderEventAndGraph({
      id: `${runId}:delegate-complete`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.tool.completed",
      nativeSessionId: `product-thread-${runId}`,
      payload: {
        kind: "tool.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          toolCallId: "call-child-b",
          status: "completed",
          detail: '<task id="ses_child_b" state="completed"><task_result>667</task_result></task>',
          data: { toolCallId: "call-child-b" },
        },
      },
    }, 1, testDb);

    const [child] = await testDb.select().from(agentExecutions).where(and(
      eq(agentExecutions.runId, runId),
      eq(agentExecutions.mode, "native_child"),
    ));
    expect(child).toMatchObject({ nativeSessionId: "ses_child_b", status: "completed" });
    expect(child?.settledAt).toBeInstanceOf(Date);
    expect(await testDb.select().from(delegationEdges).where(
      eq(delegationEdges.runId, runId),
    )).toEqual([
      expect.objectContaining({
        childExecutionId: child?.id,
        kind: "spawn",
        providerCallId: "call-child-b",
      }),
    ]);
  });

  test("keeps T3 resume observations edge-only and does not mutate attempts", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    await writeProviderEventAndGraph({
      id: `${runId}:root`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "session.started",
      nativeSessionId: "parent",
    }, 0, testDb);
    await writeProviderEventAndGraph({
      id: `${runId}:task`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.task.started",
      nativeSessionId: "child",
      nativeParentSessionId: "parent",
      nativeCallId: "child",
      payload: {
        kind: "task.started",
        payload: {
          taskId: "child",
          parentAgentId: "parent",
          toolUseId: "spawn-call",
          agentKind: "agent",
          status: "running",
        },
      },
    }, 1, testDb);
    await writeProviderEventAndGraph({
      id: `${runId}:resume-control`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.tool.completed",
      nativeSessionId: "parent",
      nativeCallId: "resume-call",
      payload: {
        kind: "tool.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          delegationKind: "resume",
          childSessionId: "child",
          toolUseId: "resume-call",
        },
      },
    }, 2, testDb);
    await writeProviderEventAndGraph({
      id: `${runId}:child-tool-complete`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.tool.completed",
      nativeSessionId: "child",
      nativeParentSessionId: "parent",
      payload: { kind: "tool.completed", payload: { toolName: "bash" } },
    }, 3, testDb);

    const [child] = await testDb.select().from(agentExecutions).where(and(
      eq(agentExecutions.runId, runId),
      eq(agentExecutions.nativeSessionId, "child"),
    ));
    expect(child).toMatchObject({ attempt: 1, status: "running" });
    expect((await testDb.select().from(delegationEdges).where(
      eq(delegationEdges.runId, runId),
    )).map((edge) => edge.kind)).toEqual(["spawn", "resume"]);
  });

  test("projects explicit Pi child identities without treating the parent session as the child", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    await writeProviderEventAndGraph({
      id: `${runId}:root`,
      runId,
      threadId: runId,
      provider: "pi",
      eventType: "session.started",
      nativeSessionId: "parent",
    }, 0, testDb);
    const frames = new NativeBridgeSequencer("parent", () => 1);
    const events = [
      { kind: "child.started", childId: "child-a", launchToolCallId: "launch-call" },
      { kind: "child.started", childId: "child-b", launchToolCallId: "launch-call" },
      { kind: "child.updated", childId: "child-a", status: "running" },
      { kind: "child.completed", childId: "child-b", status: "ok", result: "B" },
      { kind: "child.completed", childId: "child-a", status: "ok", result: "A" },
    ] as const;
    for (const [index, body] of events.entries()) {
      await writeProviderEventAndGraph(
        piBridgeProviderEvent({ runId, threadId: runId }, frames.frame(body)),
        index + 1,
        testDb,
      );
    }
    await writeProviderEventAndGraph(
      piBridgeProviderEvent(
        { runId, threadId: runId },
        frames.frame({
          kind: "message.delta",
          messageId: "child-message",
          text: "child transcript",
          ownerChildId: "child-a",
        }),
      ),
      events.length + 1,
      testDb,
    );

    const executions = await testDb.select().from(agentExecutions).where(and(
      eq(agentExecutions.runId, runId),
      eq(agentExecutions.provider, "pi"),
    ));
    expect(executions.map((row) => [row.mode, row.nativeSessionId, row.status]).sort()).toEqual([
      ["native_child", "child-a", "completed"],
      ["native_child", "child-b", "completed"],
      ["root", "parent", "running"],
    ]);
    const root = executions.find((row) => row.mode === "root");
    const children = executions.filter((row) => row.mode === "native_child");
    expect(children.every((row) => row.nativeParentSessionId === "parent")).toBe(true);
    expect(children.find((row) => row.nativeSessionId === "child-a")?.lastEventId).toEndWith(
      ":child:child-a:done",
    );
    expect((await testDb.select().from(delegationEdges).where(
      eq(delegationEdges.runId, runId),
    )).map((edge) => ({
      parent: edge.parentExecutionId,
      kind: edge.kind,
      target: edge.nativeTargetSessionId,
    })).sort((a, b) => (a.target ?? "").localeCompare(b.target ?? ""))).toEqual([
      { parent: root?.id, kind: "spawn", target: "child-a" },
      { parent: root?.id, kind: "spawn", target: "child-b" },
    ]);
  });

  test("fails open for unsupported and malformed observations", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const runId = await seedRun(orgId);
    await expect(writeProviderEventAndGraph({
      id: `${runId}:unsupported`,
      runId,
      threadId: runId,
      provider: "acp",
      eventType: "session.started",
      nativeSessionId: "ignored",
    }, 0, testDb)).resolves.toBeUndefined();
    await expect(writeProviderEventAndGraph({
      id: `${runId}:unknown`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "t3.activity.unknown",
      payload: { unexpected: true },
    }, 1, testDb)).resolves.toBeUndefined();
    await writeProviderEventAndGraph({
      id: `${runId}:root`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "session.started",
      nativeSessionId: "root-one",
    }, 2, testDb);
    await expect(writeProviderEventAndGraph({
      id: `${runId}:conflicting-root`,
      runId,
      threadId: runId,
      provider: "t3",
      eventType: "session.started",
      nativeSessionId: "root-two",
    }, 3, testDb)).resolves.toBeUndefined();
    expect(await testDb.select().from(agentExecutions).where(
      eq(agentExecutions.runId, runId),
    )).toHaveLength(1);
  });
});
