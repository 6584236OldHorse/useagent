import { expect, test } from "bun:test";
import { collectToolLifecycles } from "./canonical-timeline";

/** A tool that reports progress many times keeps every native event id, in
 * order, without the lifecycle's fields drifting; the id list is appended in
 * place rather than copied per event. */
test("collectToolLifecycles keeps every native event id in order across many progress events", () => {
  const events = [
    { kind: "tool.started", seq: 1, toolCallId: "call-1", name: "bash", title: "Run", identity: { nativeEventId: "e1" } },
    ...Array.from({ length: 500 }, (_, i) => ({
      kind: "tool.progress",
      seq: 2 + i,
      toolCallId: "call-1",
      preview: `line ${i}`,
      identity: { nativeEventId: `p${i}` },
    })),
    { kind: "tool.completed", seq: 502, toolCallId: "call-1", status: "ok", durationMs: 12, identity: { nativeEventId: "done" } },
    { kind: "tool.started", seq: 503, toolCallId: "call-2", name: "read", title: "Read" },
  ];
  const lifecycles = collectToolLifecycles(events);
  const first = lifecycles.get("call-1");
  expect(first).toBeDefined();
  expect(first?.firstSeq).toBe(1);
  expect(first?.lastSeq).toBe(502);
  expect(first?.nativeEventIds).toHaveLength(502);
  expect(first?.nativeEventIds[0]).toBe("e1");
  expect(first?.nativeEventIds[1]).toBe("p0");
  expect(first?.nativeEventIds.at(-1)).toBe("done");
  expect(first?.preview).toBe("line 499");
  expect(first?.status).toBe("ok");
  expect(first?.durationMs).toBe(12);
  // A tool without native ids keeps an empty list, never undefined.
  expect(lifecycles.get("call-2")?.nativeEventIds).toEqual([]);
});
