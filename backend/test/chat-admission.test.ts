import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { member, spendAccounts } from "../src/db/schema";
import { createOrgSession, fetchApi, json, readSse, type OrgSession } from "./helpers";

// Identity and admission at the stateless chat surface: the request runs as
// the member orgScope verified (never re-resolved into nobody), the dev
// fallback is anonymous on the house key, and a member at the allowance is
// refused before any model call. The turn itself is not metered yet.

const realFetch = globalThis.fetch;
const encoder = new TextEncoder();

/** A provider that streams one delta and records what was asked of it. */
function mockProvider(): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const body = `data: ${JSON.stringify({ id: "gen-abc", choices: [{ delta: { content: "Hi" } }] })}\n\ndata: [DONE]\n\n`;
    return new Response(encoder.encode(body), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return calls;
}

let session: OrgSession;
let userId: string;

beforeAll(async () => {
  session = await createOrgSession("chat-admission");
  const [row] = await db.select({ userId: member.userId }).from(member).where(eq(member.organizationId, session.orgId));
  userId = row!.userId;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
});

describe("POST /api/chat admission", () => {
  test("a member under the allowance is answered", async () => {
    process.env.OPENROUTER_API_KEY = "house-key";
    const calls = mockProvider();
    const res = await fetchApi("/api/chat", {
      method: "POST", cookies: session.cookies, body: { messages: [{ role: "user", content: "hello" }] },
    });
    expect(res.status).toBe(200);
    expect((await readSse(res, { timeoutMs: 8_000 })).some((event) => event.event === "done")).toBe(true);
    expect(calls.some((url) => url.includes("/chat/completions"))).toBe(true);
  });

  test("the dev fallback is anonymous: answered on the house key, capped by nothing", async () => {
    process.env.OPENROUTER_API_KEY = "house-key";
    const calls = mockProvider();
    const res = await fetchApi("/api/chat", { method: "POST", body: { messages: [{ role: "user", content: "hello from nobody" }] } });
    expect(res.status).toBe(200);
    expect((await readSse(res, { timeoutMs: 8_000 })).some((event) => event.event === "done")).toBe(true);
    expect(calls.some((url) => url.includes("/chat/completions"))).toBe(true);
  });

  test("a member at the allowance is refused with the figures before any model call", async () => {
    process.env.OPENROUTER_API_KEY = "house-key";
    await db.insert(spendAccounts).values({ orgId: session.orgId, userId, spentUsd: 50 })
      .onConflictDoUpdate({ target: [spendAccounts.orgId, spendAccounts.userId], set: { spentUsd: 50 } });
    const calls = mockProvider();
    try {
      const refused = await json<{ error: string; message: string }>("/api/chat", {
        method: "POST", cookies: session.cookies, body: { messages: [{ role: "user", content: "again" }] },
      });
      expect(refused.status).toBe(402);
      expect(refused.body.error).toBe("spend_allowance_exceeded");
      expect(refused.body.message).toContain("$50.00 of your $50.00");
      expect(calls.some((url) => url.includes("/chat/completions"))).toBe(false);
    } finally {
      await db.delete(spendAccounts).where(and(eq(spendAccounts.orgId, session.orgId), eq(spendAccounts.userId, userId)));
    }
  });
});
