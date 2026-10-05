import { afterEach, describe, expect, test } from "bun:test";
import { chatTurnCredential, chatFailure, chatTurnStream } from "./turn";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("chat turn credential", () => {
  test("a stopped run does not wait on a blocked credential read", async () => {
    const stopped = new AbortController();
    stopped.abort(new Error("Stopped by user"));
    await expect(
      chatTurnCredential({ orgId: "org-a", userId: "user-a" }, stopped.signal, {
        resolve: () => new Promise(() => {}),
      }),
    ).rejects.toThrow("Stopped by user");
  });

  test("a member without a key is told to connect one, and the failure names it", async () => {
    const attempt = chatTurnCredential({ orgId: "org-a", userId: "user-a" }, new AbortController().signal, {
      resolve: async () => null,
    });
    await expect(attempt).rejects.toThrow("Connect an OpenRouter key in Settings");
    const failure = chatFailure(await attempt.catch((error) => error));
    expect(failure).toEqual({
      label: "OpenRouter key needed",
      reason:
        "Chat cannot start: no OpenRouter key is connected for this organization. " +
        "Connect an OpenRouter key in Settings, then retry.",
    });
  });
});

describe("chat turn with a rejected key", () => {
  const run = { model: "anthropic/claude-sonnet-5", orgId: "org-a", userId: "user-a" };
  const member = { value: "sk-member", source: "user_connection" } as const;

  async function failTurn(status: number, credential: Parameters<typeof chatTurnStream>[2] = member) {
    globalThis.fetch = (async () => new Response("secret upstream body", { status })) as unknown as typeof fetch;
    const marked: unknown[] = [];
    const error = await chatTurnStream(run, [{ role: "user", content: "hello" }], credential, new AbortController().signal,
      async (input) => (marked.push(input), true)).next().then(() => null, (failure: unknown) => failure);
    return { failure: chatFailure(error), marked };
  }

  test("a 401 on the member's key marks it for reconnect and names the remedy", async () => {
    const { failure, marked } = await failTurn(401);
    expect(marked).toEqual([{ orgId: "org-a", userId: "user-a", provider: "openrouter", value: "sk-member", status: 401 }]);
    expect(failure).toEqual({
      label: "OpenRouter key rejected",
      reason: "Your OpenRouter key was rejected (expired or revoked). Reconnect it in Settings.",
    });
  });

  test("a 500 leaves the connection alone", async () => {
    const { failure, marked } = await failTurn(500);
    expect(marked).toEqual([]);
    expect(failure.label).toBe("Provider unavailable");
  });

  test("an organisation key's 401 marks no member connection", async () => {
    const { failure, marked } = await failTurn(401, { value: "sk-org", source: "org_secret" });
    expect(marked).toEqual([]);
    expect(failure.label).toBe("Provider authentication failed");
  });
});
