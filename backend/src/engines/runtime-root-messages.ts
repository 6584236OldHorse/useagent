import { createHash } from "node:crypto";
import { NativeBridgeDeltaAccumulator } from "@useagent/agent-harness/bridge";
import type { ProviderEventInput } from "../runs/provider-events";
import type { RuntimeThreadSnapshot } from "./runtime-orchestration";

type MessageSegment = { text: string; revision: string; segment: number; segmentCount: number; final: boolean; streaming: boolean };

/** Reuse already durable prefix chunks while text only appends. A rewrite gets
 * a fresh epoch and replaces every chunk atomically. Callers retain `snapshot`
 * only after `events` commit, never after a failed capture. */
export function appendOnlyMessageCapture(
  next: ProviderEventInput[],
  previous?: readonly ProviderEventInput[],
): { events: ProviderEventInput[]; snapshot: ProviderEventInput[] } {
  if (!previous) return { events: next, snapshot: next };
  const before = previous.slice(1).map((frame) => frame.payload as MessageSegment);
  const after = next.slice(1).map((frame) => frame.payload as MessageSegment);
  const previousText = before.map((segment) => segment.text).join("");
  const nextText = after.map((segment) => segment.text).join("");
  if (!nextText.startsWith(previousText)) return { events: next.slice(1), snapshot: next };
  const snapshot = next.map((frame, index) => index === 0 ? frame : {
    ...frame, payload: { ...(frame.payload as MessageSegment), revision: before[0]!.revision },
  });
  const metadataChanged = before.at(-1)!.final !== after.at(-1)!.final ||
    before.at(-1)!.streaming !== after.at(-1)!.streaming;
  const events = snapshot.slice(1).filter((_, index) => before[index]?.text !== after[index]!.text ||
    (metadataChanged && index === after.length - 1));
  return { events, snapshot };
}

/** Shared by live capture and reconciliation. Ownership comes from the runtime's
 * accepted user-message identities, never from whichever turn happens to be latest. */
export function runtimeRootMessageBatches(input: {
  runId: string;
  threadId: string;
  sessionId: string;
  userMessageIds: readonly string[];
  redact: (text: string) => string;
}, snapshot: RuntimeThreadSnapshot): ProviderEventInput[][] {
  const { latestTurn, messages } = snapshot.thread;
  const accepted = messages.filter((message) => message.role === "user" && input.userMessageIds.includes(message.id));
  const ownedTurns = new Set(accepted.flatMap((message) => message.turnId === null ? [] : [message.turnId]));
  const foreignTurns = new Set(messages.filter((message) => message.role === "user" &&
    !input.userMessageIds.includes(message.id)).flatMap((message) => message.turnId === null ? [] : [message.turnId]));
  // The pinned runtime snapshot orders messages by created_at, message_id.
  // Older versions leave user turnId null: its assistant messages belong to
  // the preceding accepted user until the next user, not to the latest turn.
  let acceptedWithoutTurn = false;
  for (const message of messages) {
    if (message.role === "user") {
      acceptedWithoutTurn = message.turnId === null && input.userMessageIds.includes(message.id);
    } else if (acceptedWithoutTurn && message.role === "assistant" && message.turnId !== null &&
      !foreignTurns.has(message.turnId)) {
      ownedTurns.add(message.turnId);
    }
  }
  // Some runtime versions omit the accepted user's turn ID. Match its exact
  // request timestamp, as the driver's accepted-run reconciliation already does.
  if (latestTurn?.requestedAt && accepted.some((message) => message.turnId === null &&
    !!message.createdAt && Number.isFinite(Date.parse(message.createdAt)) &&
    Date.parse(message.createdAt) === Date.parse(latestTurn.requestedAt!))) {
    ownedTurns.add(latestTurn.turnId);
  }
  const owned = messages.filter((message) => message.role === "assistant" &&
    message.turnId !== null && ownedTurns.has(message.turnId));
  const finalId = latestTurn?.assistantMessageId ?? owned.findLast((message) => message.turnId === latestTurn?.turnId)?.id;
  return owned.map((message) => {
    const text = input.redact(message.text);
    const final = latestTurn?.state === "completed" && message.turnId === latestTurn.turnId &&
      message.id === finalId && !message.streaming;
    const revision = createHash("sha256").update(JSON.stringify([text, message.streaming, final])).digest("hex");
    // Reuse the native bridge's UTF-8-safe 4 KiB segmentation, including its
    // authoritative empty-message representation. Never truncate a long reply.
    const segments = new NativeBridgeDeltaAccumulator().durable({
      kind: "message.authoritative", messageId: message.id, text,
    });
    const identity = createHash("sha256").update(JSON.stringify([input.sessionId, message.turnId, message.id])).digest("hex");
    const prefix = `pe_${input.runId}_root-message-${identity}`;
    const base = {
      runId: input.runId, threadId: input.threadId, provider: "t3",
      nativeSessionId: input.sessionId, nativeParentSessionId: null,
      nativeMessageId: message.id, nativePartId: null, nativeCallId: null,
    };
    return [
      { ...base, id: `${prefix}:start`, eventType: "t3.message.started",
        payload: { role: "assistant", turnId: message.turnId } },
      ...segments.map((segment, index): ProviderEventInput => ({
        ...base, id: `${prefix}:${index}`, eventType: "t3.message.updated",
        payload: { role: "assistant", turnId: message.turnId,
          text: "text" in segment ? segment.text : "", revision,
          segment: index, segmentCount: segments.length, final, streaming: message.streaming },
      })),
    ];
  });
}
