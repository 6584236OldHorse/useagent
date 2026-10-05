import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  CONTINUATION_PROMPT,
  RUNTIME_EMPTY_TERMINAL_OUTPUT_ERROR,
  RuntimeTurnFailedError,
  TURN_RECOVERY_ATTEMPTS,
  continuationRunId,
  describeUpstreamOutcome,
  transientProviderFailure,
  turnRecovery,
} from "./turn-recovery";

describe("turn recovery policy", () => {
  test("continues once after a turn that ended without an answer", () => {
    const first = turnRecovery(new Error(RUNTIME_EMPTY_TERMINAL_OUTPUT_ERROR), 1);
    expect(first?.prompt).toBe(CONTINUATION_PROMPT);
    expect(first?.delayMs).toBe(0);
    expect(first?.answerMayBeLate).toBe(true);
    expect(turnRecovery(new Error(RUNTIME_EMPTY_TERMINAL_OUTPUT_ERROR), TURN_RECOVERY_ATTEMPTS + 1)).toBeNull();
  });

  test("waits before retrying a transient provider failure the runtime reported", () => {
    const recovery = turnRecovery(new RuntimeTurnFailedError("upstream returned 503 Service Unavailable"), 1);
    expect(recovery?.delayMs).toBe(5_000);
    expect(recovery?.answerMayBeLate).toBe(false);
    expect(recovery?.label).toContain("Trying once more");
  });

  test("a failure to watch the thread never restarts a turn that may still be running", () => {
    expect(turnRecovery(new Error("Box API request failed (503)"), 1)).toBeNull();
    expect(turnRecovery(new Error("subscription ticket request timed out"), 1)).toBeNull();
  });

  test("a continuation dispatches under its own identity", () => {
    expect(continuationRunId("run-1", 2)).not.toBe("run-1");
    expect(continuationRunId("run-1", 2)).toBe(continuationRunId("run-1", 2));
    const source = readFileSync(new URL("./runtime-adapter.ts", import.meta.url), "utf8");
    expect(source).toContain("runId: attempt === 1 ? ctx.runId : continuationRunId(ctx.runId, attempt),");
    expect(source).toContain("throw new RuntimeTurnFailedError(redact.text(error));");
  });

  test("lets every other failure stand", () => {
    expect(turnRecovery(new RuntimeTurnFailedError("model_provider: invalid api key"), 1)).toBeNull();
    expect(turnRecovery(new Error("tool execution failed"), 1)).toBeNull();
    expect(turnRecovery("not an error", 1)).toBeNull();
  });

  test("separates capacity and connection failures from refused requests", () => {
    for (const message of [
      "429 Too Many Requests",
      "rate limit exceeded",
      "provider overloaded",
      "request timed out",
      "fetch failed: ECONNRESET",
      "502 Bad Gateway",
    ]) {
      expect(transientProviderFailure(message)).toBe(true);
    }
    for (const message of [
      "401 unauthorized",
      "403 forbidden: api key revoked",
      "invalid_request_error: max_tokens too large",
      "429 insufficient_quota",
      "model not found",
    ]) {
      expect(transientProviderFailure(message)).toBe(false);
    }
  });

  test("names the upstream outcome the gateway recorded", () => {
    expect(describeUpstreamOutcome(null)).toBeNull();
    expect(describeUpstreamOutcome({ outcome: "started", upstreamStatus: null })).toBeNull();
    expect(describeUpstreamOutcome({ outcome: "failed", upstreamStatus: 529 })).toBe("last provider call answered 529");
    expect(describeUpstreamOutcome({ outcome: "failed", upstreamStatus: null })).toBe("last provider call failed before answering");
    expect(describeUpstreamOutcome({ outcome: "ok", upstreamStatus: null })).toBe("last provider call answered");
  });
});
