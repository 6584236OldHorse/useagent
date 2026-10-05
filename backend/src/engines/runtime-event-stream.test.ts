import { describe, expect, test } from "bun:test";
import {
  buildRuntimeThreadSubscriptionRequest,
  decodeRuntimeThreadStreamItems,
  followRuntimeThreadSnapshots,
  type RuntimeThreadStreamItem,
} from "./runtime-event-stream";
import type { RuntimeThreadSnapshot } from "./runtime-orchestration";

function snapshot(sequence: number): RuntimeThreadSnapshot {
  return {
    snapshotSequence: sequence,
    thread: {
      id: "skynet-thread-1",
      latestTurn: null,
      messages: [],
      activities: [],
      session: null,
    },
  };
}

describe("T3 native thread event stream", () => {
  test("builds the Effect RPC subscribe request with a replay watermark", () => {
    expect(buildRuntimeThreadSubscriptionRequest("skynet-thread-1", 41)).toEqual({
      _tag: "Request",
      id: 1,
      tag: "orchestration.subscribeThread",
      payload: {
        threadId: "skynet-thread-1",
        afterSequence: 41,
        requestCompletionMarker: true,
      },
      headers: [],
    });
  });

  test("requests an authoritative websocket snapshot when no replay watermark is supplied", () => {
    expect(buildRuntimeThreadSubscriptionRequest("skynet-thread-1")).toEqual({
      _tag: "Request",
      id: 1,
      tag: "orchestration.subscribeThread",
      payload: {
        threadId: "skynet-thread-1",
        requestCompletionMarker: true,
      },
      headers: [],
    });
  });

  test("decodes only thread stream items from the matching RPC chunk", () => {
    const items = decodeRuntimeThreadStreamItems(JSON.stringify({
      _tag: "Chunk",
      requestId: 1,
      values: [
        {
          kind: "snapshot",
          snapshot: {
            snapshotSequence: 42,
            thread: {
              id: "skynet-thread-1",
              latestTurn: null,
              messages: [],
              activities: [],
              session: null,
            },
          },
        },
        {
          kind: "event",
          event: {
            sequence: 43,
            aggregateKind: "thread",
            aggregateId: "skynet-thread-1",
          },
        },
        { kind: "synchronized" },
        { kind: "snapshot", snapshot: { snapshotSequence: 44 } },
        { kind: "event", event: { sequence: 45, aggregateId: "skynet-thread-1" } },
        { kind: "unrelated" },
      ],
    }));
    expect(items.map(({ kind }) => kind)).toEqual([
      "snapshot",
      "event",
      "synchronized",
    ]);
    expect(decodeRuntimeThreadStreamItems('{"_tag":"Exit","requestId":1,"exit":{"_tag":"Success"}}')).toEqual([]);
  });

  test("serializes a delayed refresh snapshot before a newer websocket snapshot", async () => {
    const applied: number[] = [];
    const lowerStarted = Promise.withResolvers<void>();
    const releaseLower = Promise.withResolvers<void>();

    await followRuntimeThreadSnapshots({
      sandbox: {} as never,
      threadId: "skynet-thread-1",
      initialSequence: 0,
      signal: new AbortController().signal,
      readSnapshot: async () => snapshot(1),
      applySnapshot: async (value) => {
        if (value.snapshotSequence === 1) {
          lowerStarted.resolve();
          await releaseLower.promise;
        }
        applied.push(value.snapshotSequence);
        return value.snapshotSequence !== 2;
      },
      subscribe: async (_sandbox, _threadId, _after, _signal, onItem) => {
        expect(await onItem({
          kind: "event",
          event: { sequence: 1, aggregateKind: "thread", aggregateId: "skynet-thread-1" },
        })).toBe(true);
        await lowerStarted.promise;
        const newer = onItem({ kind: "snapshot", snapshot: snapshot(2) });
        releaseLower.resolve();
        expect(await newer).toBe(false);
      },
    });

    expect(applied).toEqual([1, 2]);
  });

  test("does not apply a queued snapshot after a terminal snapshot stops following", async () => {
    const applied: number[] = [];
    const terminalStarted = Promise.withResolvers<void>();
    const releaseTerminal = Promise.withResolvers<void>();

    await followRuntimeThreadSnapshots({
      sandbox: {} as never,
      threadId: "skynet-thread-1",
      initialSequence: 0,
      signal: new AbortController().signal,
      readSnapshot: async () => {
        throw new Error("unexpected refresh");
      },
      applySnapshot: async (value) => {
        applied.push(value.snapshotSequence);
        terminalStarted.resolve();
        await releaseTerminal.promise;
        return false;
      },
      subscribe: async (
        _sandbox,
        _threadId,
        _after,
        _signal,
        onItem: (item: RuntimeThreadStreamItem) => Promise<boolean>,
      ) => {
        const terminal = onItem({ kind: "snapshot", snapshot: snapshot(1) });
        await terminalStarted.promise;
        const late = onItem({ kind: "snapshot", snapshot: snapshot(2) });
        releaseTerminal.resolve();
        expect(await terminal).toBe(false);
        expect(await late).toBe(false);
      },
    });

    expect(applied).toEqual([1]);
  });

  test.each([true, false])("settles a pending refresh before a socket failure (terminal=%s)", async (terminal) => {
    const applied: number[] = [];
    const readStarted = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    const socketError = new Error("socket closed");
    const following = followRuntimeThreadSnapshots({
      sandbox: {} as never,
      threadId: "skynet-thread-1",
      initialSequence: 0,
      signal: new AbortController().signal,
      readSnapshot: async () => {
        readStarted.resolve();
        await releaseRead.promise;
        return snapshot(1);
      },
      applySnapshot: async (value) => {
        applied.push(value.snapshotSequence);
        return !terminal;
      },
      subscribe: async (_sandbox, _threadId, _after, _signal, onItem) => {
        await onItem({
          kind: "event",
          event: { sequence: 1, aggregateKind: "thread", aggregateId: "skynet-thread-1" },
        });
        await readStarted.promise;
        releaseRead.resolve();
        throw socketError;
      },
    });

    if (terminal) await expect(following).resolves.toBeUndefined();
    else await expect(following).rejects.toBe(socketError);
    expect(applied).toEqual([1]);
  });

  test("rejects an unsolicited successful stream exit after only a running snapshot", async () => {
    await expect(followRuntimeThreadSnapshots({
      sandbox: {} as never,
      threadId: "skynet-thread-1",
      initialSequence: 0,
      signal: new AbortController().signal,
      readSnapshot: async () => {
        throw new Error("unexpected refresh");
      },
      applySnapshot: async () => true,
      subscribe: async (_sandbox, _threadId, _after, _signal, onItem) => {
        expect(await onItem({ kind: "snapshot", snapshot: snapshot(1) })).toBe(true);
        // Models an unsolicited Effect RPC Exit Success.
      },
    })).rejects.toThrow("ended before a terminal snapshot");
  });

  test("applies events in place and reads a full snapshot only across a gap or an event it cannot apply", async () => {
    const activity = (id: string, kind = "tool.started") => ({
      id, tone: "tool" as const, kind, summary: id, payload: {}, turnId: "turn-1",
    });
    const withActivities = (sequence: number, ids: readonly string[]): RuntimeThreadSnapshot => ({
      ...snapshot(sequence),
      thread: { ...snapshot(sequence).thread, activities: ids.map((id) => activity(id)) },
    });
    const appended = (sequence: number, id: string, kind?: string): RuntimeThreadStreamItem => ({
      kind: "event",
      event: {
        sequence, aggregateKind: "thread", aggregateId: "skynet-thread-1",
        type: "thread.activity-appended", payload: { threadId: "skynet-thread-1", activity: activity(id, kind) },
      },
    });
    const applied: string[] = [];
    const readStarted = Promise.withResolvers<void>();
    const releaseRead = Promise.withResolvers<void>();
    let reads = 0;
    let readMs = 0;
    const ended = Promise.withResolvers<void>();

    await followRuntimeThreadSnapshots({
      sandbox: {} as never,
      threadId: "skynet-thread-1",
      initialSequence: 9,
      signal: new AbortController().signal,
      readSnapshot: async () => {
        reads += 1;
        if (reads === 2) return { ...withActivities(17, ["a-11", "a-12", "a-13", "a-14", "a-16"]) };
        readStarted.resolve();
        await releaseRead.promise;
        // The runtime's snapshot holds a-12, which the stream never delivered.
        return withActivities(13, ["a-11", "a-12", "a-13"]);
      },
      onRead: (ms) => { readMs += ms; },
      applySnapshot: async (value) => {
        applied.push(`${value.snapshotSequence}:${value.thread.activities.map(({ id }) => id).join(",")}`);
        if (value.snapshotSequence === 17) ended.resolve();
        return value.snapshotSequence !== 17;
      },
      subscribe: async (_sandbox, _threadId, _after, _signal, onItem) => {
        expect(await onItem({ kind: "snapshot", snapshot: withActivities(10, []) })).toBe(true);
        await onItem(appended(11, "a-11"));
        // 12 never arrives: a gap before anything but a tool update reads the thread.
        await onItem(appended(13, "a-13"));
        await readStarted.promise;
        // Delivered while that read is in flight: it waits and applies on top of it.
        await onItem(appended(14, "a-14"));
        releaseRead.resolve();
        await Bun.sleep(5);
        // The runtime's stream drops superseded tool updates, so this jump is not a gap.
        await onItem(appended(16, "a-16", "tool.updated"));
        // A session change is not applied in place.
        await onItem({ kind: "event", event: {
          sequence: 17, aggregateKind: "thread", aggregateId: "skynet-thread-1",
          type: "thread.session-set", payload: { threadId: "skynet-thread-1", session: { status: "ready" } },
        } });
        await ended.promise;
      },
    });

    expect(reads).toBe(2);
    expect(readMs).toBeGreaterThan(0);
    expect(applied).toEqual([
      "10:",
      "11:a-11",
      "13:a-11,a-12,a-13",
      "14:a-11,a-12,a-13,a-14",
      "16:a-11,a-12,a-13,a-14,a-16",
      "17:a-11,a-12,a-13,a-14,a-16",
    ]);
  });
});
