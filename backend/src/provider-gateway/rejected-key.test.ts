import { describe, expect, test } from "bun:test";
import {
  providerRejectedKey,
  rejectedMemberKeyResponse,
  relayedKeyRejectedFailure,
} from "./rejected-key";

const key = { orgId: "org-a", userId: "user-a", provider: "openrouter", value: "sk-member" } as const;
const REMEDY = "Your OpenRouter key was rejected (expired or revoked). Reconnect it in Settings.";

function recorder() {
  const calls: unknown[] = [];
  return { calls, mark: async (input: unknown) => (calls.push(input), true) };
}

describe("rejected provider keys", () => {
  test("only a 401, or a 403 naming a bad key, is a rejected key", () => {
    expect(providerRejectedKey(401)).toBe(true);
    expect(providerRejectedKey(403, '{"error":{"message":"Invalid API key"}}')).toBe(true);
    expect(providerRejectedKey(403, "This key has been disabled")).toBe(true);
    expect(providerRejectedKey(403, '{"error":{"message":"Key limit exceeded"}}')).toBe(false);
    expect(providerRejectedKey(403, "Your input was flagged by moderation")).toBe(false);
    for (const status of [402, 429, 500, 502, 503]) expect(providerRejectedKey(status, "expired key")).toBe(false);
  });

  test("a 401 marks the exact key and replaces the provider's body with the remedy", async () => {
    const { calls, mark } = recorder();
    const response = await rejectedMemberKeyResponse(
      new Response('{"error":{"message":"secret upstream detail"}}', { status: 401 }),
      key,
      mark,
    );
    expect(calls).toEqual([{ ...key, status: 401 }]);
    expect(response?.status).toBe(401);
    expect(response?.headers.get("x-should-retry")).toBe("false");
    const body = await response?.text();
    expect(body).toContain(REMEDY);
    expect(body).not.toContain("secret upstream detail");
  });

  test("a 5xx, a spent key and a policy refusal pass through without marking", async () => {
    const { calls, mark } = recorder();
    for (const upstream of [
      new Response("upstream down", { status: 500 }),
      new Response('{"error":{"message":"Key limit exceeded"}}', { status: 403 }),
      new Response("flagged", { status: 403 }),
    ]) {
      expect(await rejectedMemberKeyResponse(upstream, key, mark)).toBeNull();
      expect(await upstream.text()).not.toBe("");
    }
    expect(calls).toEqual([]);
  });

  test("an engine relaying the gateway's remedy is named plainly", () => {
    expect(relayedKeyRejectedFailure(`AI_APICallError: ${REMEDY}`)).toEqual({
      label: "OpenRouter key rejected",
      reason: REMEDY,
    });
    expect(relayedKeyRejectedFailure("401 Unauthorized")).toBeNull();
  });
});
