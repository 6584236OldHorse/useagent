import { expect, test } from "bun:test";
import { type OpenCodeFrame, translateOpenCode } from "@useagent/agent-harness/opencode";
import { renderToStaticMarkup } from "react-dom/server";
import { buildTimelineFromCanonical, type CanonicalEventLike } from "./canonical-timeline";
import { createNativeStore } from "./native-store";
import { buildTimeline } from "./timeline";
import { Timeline } from "./timeline-view";
import { splitTurn } from "./turn-trace-model";

function message(
  id: string,
  seq: number,
  text: string,
  final = false,
  revision = "1",
): [OpenCodeFrame, OpenCodeFrame] {
  const native = {
    sessionId: "root",
    parentSessionId: null,
    messageId: id,
    partId: null,
    callId: null,
  };
  return [
    {
      eventId: `${id}:start`,
      seq,
      provider: "t3",
      eventType: "t3.message.started",
      native,
      payload: { role: "assistant", turnId: "owned" },
    },
    {
      eventId: `${id}:0`,
      seq: seq + 1,
      provider: "t3",
      eventType: "t3.message.updated",
      native,
      payload: {
        role: "assistant",
        turnId: "owned",
        text,
        revision,
        segment: 0,
        segmentCount: 1,
        final,
        streaming: !final,
      },
    },
  ];
}

const canonicalTimeline = (events: unknown, live: boolean) =>
  buildTimelineFromCanonical(events as CanonicalEventLike[], new Map(), live);

test("fresh native and canonical replay retain interim prose and replace only the final message", () => {
  const frames = [
    ...message("progress", 1, "I need your approval before continuing."),
    ...message("final", 3, "The request was denied.", true),
  ];
  const store = createNativeStore();
  for (const frame of frames) store.ingestNative({ schemaVersion: 1, ...frame }, 0);
  const native = buildTimeline(store.getSnapshot(), false) ?? [];
  const translated = translateOpenCode(frames, { runId: "run", threadId: "thread" }, []);
  const canonical = canonicalTimeline(translated.events, false);
  for (const nodes of [native, canonical]) {
    expect(nodes.filter((node) => node.kind === "text").map((node) => node.text)).toEqual([
      "I need your approval before continuing.",
      "The request was denied.",
    ]);
    const html = renderToStaticMarkup(
      <Timeline nodes={nodes} live={false} settledReply="Denied final summary." />,
    );
    expect(html).toContain("I need your approval before continuing.");
    expect(html.match(/Denied final summary\./g)).toHaveLength(1);
    expect(html).not.toContain("The request was denied.");
  }
});

test("pending approval narration is durable without any volatile live text", () => {
  const store = createNativeStore();
  for (const frame of message("progress", 1, "Waiting for approval.")) {
    store.ingestNative({ schemaVersion: 1, ...frame }, 0);
  }
  const nodes = buildTimeline(store.getSnapshot(), true) ?? [];
  expect(renderToStaticMarkup(<Timeline nodes={nodes} live />)).toContain("Waiting for approval.");
});

test("a streaming tail remains the live reply but non-final settled text becomes work", () => {
  const node = { kind: "text" as const, key: "message", messageId: "message", text: "Streaming answer", final: false };
  const nodes = [node];
  expect(splitTurn(nodes, true)).toMatchObject({ reply: "Streaming answer", work: [] });
  expect(splitTurn(nodes, false)).toMatchObject({ reply: null, work: nodes });
  expect(splitTurn([{ ...node, final: true }], false)).toMatchObject({ reply: "Streaming answer", work: [] });
});

test("authoritative text revisions retain message order and exclude non-root assistant identities", () => {
  const progress = message("progress", 1, "Original progress.");
  const final = message("final", 3, "Final answer.", true);
  const revision = {
    ...progress[1],
    seq: 20,
    payload: {
      ...(progress[1].payload as object),
      text: "Revised progress.",
      revision: "revision-2",
    },
  };
  const foreign = message("foreign", 5, "User/system/child text.");
  foreign[0].payload = { role: "user", turnId: "owned" };
  foreign[1].payload = { ...(foreign[1].payload as object), role: "user" };
  const child = message("child", 7, "Child-only prose.");
  for (const frame of child) frame.native.parentSessionId = "parent";
  const frames = [...progress, ...final, ...foreign, ...child, revision];
  const store = createNativeStore();
  for (const frame of frames) store.ingestNative({ schemaVersion: 1, ...frame }, 0);
  const events = translateOpenCode(
    store.getSnapshot().nativeFrames,
    { runId: "run", threadId: "thread" },
    [],
  ).events;
  for (const nodes of [
    buildTimeline(store.getSnapshot(), true) ?? [],
    canonicalTimeline(events, true),
  ]) {
    expect(nodes.filter((node) => node.kind === "text").map((node) => node.text)).toEqual([
      "Revised progress.",
      "Final answer.",
    ]);
  }
});

test("large Unicode snapshots recompose only after every segment of the latest revision arrives", () => {
  const text = `🧪${"🌍".repeat(40_000)}done`;
  const cut = Math.floor(text.length / 2);
  const frames = message("large", 1, "stale ", false, "old");
  const native = frames[0].native;
  frames[1] = { ...frames[1], payload: { ...(frames[1].payload as object), segmentCount: 2 } };
  frames.push({
    eventId: "large:1",
    seq: 3,
    provider: "t3",
    eventType: "t3.message.updated",
    native,
    payload: {
      role: "assistant",
      turnId: "owned",
      text: "snapshot",
      revision: "old",
      segment: 1,
      segmentCount: 2,
      final: false,
      streaming: true,
    },
  });
  frames.push({
    eventId: "large:0",
    seq: 4,
    provider: "t3",
    eventType: "t3.message.updated",
    native,
    payload: {
      role: "assistant",
      turnId: "owned",
      text: text.slice(0, cut),
      revision: "new",
      segment: 0,
      segmentCount: 2,
      final: true,
      streaming: false,
    },
  });
  const store = createNativeStore();
  for (const frame of frames) store.ingestNative({ schemaVersion: 1, ...frame }, 0);
  expect(buildTimeline(store.getSnapshot(), false)?.filter((node) => node.kind === "text")).toEqual(
    [],
  );

  const last = {
    eventId: "large:1",
    seq: 5,
    provider: "t3",
    eventType: "t3.message.updated",
    native,
    payload: {
      role: "assistant",
      turnId: "owned",
      text: text.slice(cut),
      revision: "new",
      segment: 1,
      segmentCount: 2,
      final: true,
      streaming: false,
    },
  } satisfies OpenCodeFrame;
  store.ingestNative({ schemaVersion: 1, ...last }, 0);
  const translated = translateOpenCode([...frames, last], { runId: "run", threadId: "thread" }, []);
  for (const nodes of [
    buildTimeline(store.getSnapshot(), false) ?? [],
    canonicalTimeline(translated.events, false),
  ]) {
    expect(nodes.filter((node) => node.kind === "text")).toEqual([
      { kind: "text", key: "message:large", text, messageId: "large", final: true },
    ]);
  }
});

test("empty authoritative revisions replace stale text and no-final commentary survives summary replacement", () => {
  const progress = message("progress", 1, "Keep this commentary.");
  const final = message("final", 3, "Stale answer.", true, "old");
  final.push({
    ...final[1],
    seq: 5,
    payload: { ...(final[1].payload as object), text: "", revision: "empty" },
  });
  const frames = [...progress, ...final];
  const store = createNativeStore();
  for (const frame of frames) store.ingestNative({ schemaVersion: 1, ...frame }, 0);
  const events = translateOpenCode(
    store.getSnapshot().nativeFrames,
    { runId: "run", threadId: "thread" },
    [],
  ).events;
  for (const nodes of [
    buildTimeline(store.getSnapshot(), false) ?? [],
    canonicalTimeline(events, false),
  ]) {
    expect(nodes.filter((node) => node.kind === "text").map((node) => node.text)).toEqual([
      "Keep this commentary.",
    ]);
    const html = renderToStaticMarkup(
      <Timeline nodes={nodes} live={false} settledReply="Summary." />,
    );
    expect(html).toContain("Keep this commentary.");
    expect(html).toContain("Summary.");
    expect(html).not.toContain("Stale answer.");
  }
});

test("append-only epochs reuse durable prefix chunks with their older segment counts", () => {
  const frames = message("append", 1, "prefix", false, "epoch");
  frames.push({
    ...frames[1],
    eventId: "append:1",
    seq: 3,
    payload: {
      role: "assistant",
      turnId: "owned",
      text: " tail",
      revision: "epoch",
      segment: 1,
      segmentCount: 2,
      final: true,
      streaming: false,
    },
  });
  const store = createNativeStore();
  for (const frame of frames) store.ingestNative({ schemaVersion: 1, ...frame }, 0);
  const events = translateOpenCode(frames, { runId: "run", threadId: "thread" }, []).events;
  for (const nodes of [
    buildTimeline(store.getSnapshot(), false) ?? [],
    canonicalTimeline(events, false),
  ]) {
    expect(nodes.filter((node) => node.kind === "text")).toEqual([
      {
        kind: "text",
        key: "message:append",
        messageId: "append",
        text: "prefix tail",
        final: true,
      },
    ]);
  }
});

test("canonical narration projection is provider-neutral", () => {
  const identity = {
    provider: "future-runtime",
    nativeSessionId: "root",
    nativeParentSessionId: null,
    nativeMessageId: "neutral-message",
  };
  const nodes = canonicalTimeline(
    [
      {
        kind: "message.started",
        seq: 1,
        identity: { ...identity, nativeSeq: 10 },
        messageId: "neutral-message",
        role: "assistant",
        turnId: "turn",
      },
      {
        kind: "message.delta",
        seq: 2,
        identity: { ...identity, nativeSeq: 11 },
        messageId: "neutral-message",
        role: "assistant",
        turnId: "turn",
        text: "Neutral narration.",
        snapshot: {
          revision: "revision",
          segment: 0,
          segmentCount: 1,
          final: true,
          streaming: false,
        },
      },
    ] satisfies CanonicalEventLike[],
    false,
  );

  expect(nodes.filter((node) => node.kind === "text")).toEqual([
    {
      kind: "text",
      key: "message:neutral-message",
      messageId: "neutral-message",
      text: "Neutral narration.",
      final: true,
    },
  ]);
});
