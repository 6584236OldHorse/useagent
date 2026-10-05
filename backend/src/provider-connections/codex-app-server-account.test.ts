import { describe, expect, test } from "bun:test";
import { readCodexRateLimits } from "./codex-app-server-account";
import type { CodexAppServerClient } from "./codex-app-server-contracts";

function client(response: unknown): CodexAppServerClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request(method) {
      calls.push(method);
      return response;
    },
  };
}

describe("readCodexRateLimits", () => {
  test("reads both windows from the account rate-limit response", async () => {
    const appServer = client({
      rateLimits: {
        planType: "plus",
        primary: { usedPercent: 38, windowDurationMins: 300, resetsAt: 1_789_000_000 },
        secondary: { usedPercent: 3.5, windowDurationMins: 10_080, resetsAt: 1_789_300_000 },
      },
    });
    expect(await readCodexRateLimits(appServer)).toEqual({
      planType: "plus",
      primary: { usedPercent: 38, windowDurationMins: 300, resetsAt: 1_789_000_000 },
      secondary: { usedPercent: 3.5, windowDurationMins: 10_080, resetsAt: 1_789_300_000 },
    });
    expect(appServer.calls).toEqual(["account/rateLimits/read"]);
  });

  test("drops windows without a usage figure and tolerates a bare response", async () => {
    expect(await readCodexRateLimits(client({ rateLimits: { primary: { resetsAt: 1 } } }))).toEqual({
      planType: null,
      primary: null,
      secondary: null,
    });
    await expect(readCodexRateLimits(client(null))).rejects.toThrow();
  });
});
