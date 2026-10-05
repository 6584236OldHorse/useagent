import { afterEach, describe, expect, test } from "bun:test";
import { providerKeyLimitReason } from "../provider-gateway/key-limit";
import {
  ChatStreamError,
  openRouterMessages,
  SafeChatStreamError,
  streamChat,
} from "./stream";
import { chatFailure } from "./turn";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("chat provider message boundary", () => {
  test("maps provider-neutral image bytes to an OpenRouter data URI", () => {
    expect(openRouterMessages([{
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image", contentType: "image/png", bytes: new Uint8Array([1, 2, 3]) },
      ],
    }])).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "describe this" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } },
      ],
    }]);
  });

  test("classifies provider HTTP failures without retaining response bodies", async () => {
    for (const [status, category] of [
      [401, "authentication"],
      [402, "credits"],
      [403, "policy"],
      [429, "rate_limit"],
      [503, "availability"],
    ] as const) {
      globalThis.fetch = (async () =>
        new Response("secret upstream body", { status })) as unknown as typeof fetch;
      const error = await streamChat([{ role: "user", content: "hello" }], "model", "key")
        .next().then(() => null, (failure) => failure);
      expect(error).toBeInstanceOf(SafeChatStreamError);
      expect(error).toMatchObject({ status, category });
      expect(String(error)).not.toContain("secret upstream body");
    }
  });

  test("preserves the allowlisted OpenRouter key-limit classification without its body", async () => {
    globalThis.fetch = (async () => new Response(
      '{"error":{"message":"Key limit exceeded","secret":"discard me"}}',
      { status: 403 },
    )) as unknown as typeof fetch;
    const error = await streamChat([{ role: "user", content: "hello" }], "model", "key")
      .next().then(() => null, (failure) => failure);
    expect(error).toMatchObject({ status: 403, category: "key_limit" });
    expect(String(error)).not.toContain("discard me");
    expect(chatFailure(error).reason).toBe(providerKeyLimitReason("key limit exceeded") ?? "");
  });

  test("bounds oversized 403 classification bodies", async () => {
    const raw = `Key limit exceeded ${"private detail ".repeat(20_000)}`;
    globalThis.fetch = (async () => new Response(raw, { status: 403 })) as unknown as typeof fetch;
    const error = await streamChat([{ role: "user", content: "hello" }], "model", "key")
      .next().then(() => null, (failure) => failure);
    expect(error).toMatchObject({ status: 403, category: "key_limit" });
    expect(String(error)).not.toContain("private detail");
  });

  test("deadlines a never-ending 403 classification body", async () => {
    globalThis.fetch = (async () => new Response(
      new ReadableStream<Uint8Array>({ start() {} }),
      { status: 403 },
    )) as unknown as typeof fetch;
    const startedAt = Date.now();
    const error = await streamChat([{ role: "user", content: "hello" }], "model", "key")
      .next().then(() => null, (failure) => failure);
    expect(error).toMatchObject({ status: 403, category: "policy" });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test("does not retain provider stream error messages", async () => {
    globalThis.fetch = (async () => new Response(
      `data: ${JSON.stringify({ error: { message: "secret stream detail" } })}\n\n`,
      { status: 200 },
    )) as unknown as typeof fetch;

    const error = await streamChat([{ role: "user", content: "hello" }], "model", "key")
      .next().then(() => null, (failure) => failure);
    expect(error).toBeInstanceOf(ChatStreamError);
    expect(String(error)).not.toContain("secret stream detail");
  });
});
