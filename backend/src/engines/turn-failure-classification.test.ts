import { describe, expect, test } from "bun:test";
import {
  classifyTurnFailure,
  isTransientStreamDrop,
} from "./turn-failure-classification";

describe("turn failure classification", () => {
  test("classifies a dropped provider stream as transient and resumable", () => {
    const failure = classifyTurnFailure(
      new Error("The provider stream closed before the turn settled"),
    );
    expect(failure.kind).toBe("transient");
    expect(failure.resumable).toBe(true);
    expect(failure.summary).toContain("interrupted");
    expect(failure.summary).toContain("resume");
    // No em dashes in a user-visible summary.
    expect(failure.summary).not.toContain("—");
  });

  test("treats both other stream-drop markers as transient", () => {
    for (const message of [
      "The provider stream connection failed",
      "The provider thread subscription failed",
    ]) {
      expect(isTransientStreamDrop(new Error(message))).toBe(true);
      expect(classifyTurnFailure(new Error(message)).kind).toBe("transient");
    }
  });

  test("classifies a real provider error as non-transient and non-resumable", () => {
    const failure = classifyTurnFailure(
      new Error("model refused: content policy violation"),
    );
    expect(failure.kind).toBe("provider");
    expect(failure.resumable).toBe(false);
    // Mirrors the worker's existing `error: <message>` shape (truncated, single-spaced).
    expect(failure.summary).toBe("error: model refused: content policy violation");
  });

  test("collapses whitespace and truncates a long provider error summary", () => {
    const failure = classifyTurnFailure(new Error(`boom\n\t${"x".repeat(300)}`));
    expect(failure.kind).toBe("provider");
    expect(failure.summary.startsWith("error: boom ")).toBe(true);
    // "error: " (7) + 180 chars of payload.
    expect(failure.summary.length).toBe(7 + 180);
  });

  test("names a spent provider key plainly instead of relaying the refusal", () => {
    const failure = classifyTurnFailure(
      new Error('upstream 403: {"error":{"message":"Key limit exceeded","code":403}}'),
    );
    expect(failure.kind).toBe("provider");
    expect(failure.label).toBe("Provider key limit reached");
    expect(failure.summary).toContain("reached its spending limit");
    expect(failure.summary).not.toContain("—");
  });

  test("names a member key the gateway reported rejected, without the engine's wrapping", () => {
    const failure = classifyTurnFailure(new Error(
      'APIError: 401 {"type":"error","error":{"type":"authentication_error","message":"Your Anthropic key was rejected (expired or revoked). Reconnect it in Settings."}}',
    ));
    expect(failure).toEqual({
      kind: "provider",
      resumable: false,
      label: "Anthropic key rejected",
      summary: "Your Anthropic key was rejected (expired or revoked). Reconnect it in Settings.",
    });
  });

  test("falls back to a generic engine error for a message-less throw", () => {
    const failure = classifyTurnFailure(new Error(""));
    expect(failure.kind).toBe("provider");
    expect(failure.summary).toBe("engine error");
  });

  test("does not treat an unrelated stream mention as transient", () => {
    expect(
      isTransientStreamDrop(new Error("stream parse error: invalid JSON frame")),
    ).toBe(false);
  });

  test("redacts provider credentials before they enter a durable failure summary", () => {
    const secret = "sk-or-v1-super-secret";
    const failure = classifyTurnFailure(
      new Error(`401 invalid API key ${secret}`),
      (text) => text.replaceAll(secret, "<redacted>"),
    );
    expect(failure.summary).toBe("error: 401 invalid API key <redacted>");
    expect(failure.summary).not.toContain(secret);
  });
});
