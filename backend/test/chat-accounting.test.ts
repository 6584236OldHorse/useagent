import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, like } from "drizzle-orm";
import { db } from "../src/db/client";
import { member, providerEvents, runs, spendAccounts, spendEntries } from "../src/db/schema";
import { chatTurnStream } from "../src/chat/turn";
import { finalizeRun } from "../src/runs/finalize";
import { drainProviderEvents } from "../src/runs/provider-events";
import { createOrgSession, fetchApi, json, readSse, uid, waitFor, type OrgSession } from "./helpers";

// Chat accounting through the REAL stream client against a mocked provider:
// the generation id is captured from the first chunk that names it, the
// settled per-generation figure is read back when the deployment key served
// the turn and wins over the streamed usage, a stream that breaks after the
// provider started billing is still priced, a customer key is never read back,
// and the stateless POST /api/chat surface is admitted and charged like a run.

const realFetch = globalThis.fetch;
const encoder = new TextEncoder();

function sse(lines: Array<Record<string, unknown> | "[DONE]">): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const line of lines) {
          await Bun.sleep(5);
          controller.enqueue(encoder.encode(`data: ${line === "[DONE]" ? line : JSON.stringify(line)}\n\n`));
        }
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const chunk = (content: string, id = "gen-abc") => ({ id, choices: [{ delta: { content } }] });
const usage = (cost: number | null, id = "gen-abc") => ({
  id, choices: [{ delta: { content: "" } }], usage: { total_tokens: 42, ...(cost === null ? {} : { cost }) },
});

/** A provider that streams `stream` and answers the generation read-back with `settled`. */
function mockProvider(stream: Array<Record<string, unknown> | "[DONE]">, settled: number | null) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/generation?id=")) {
      return settled === null
        ? new Response("not yet", { status: 404 })
        : Response.json({ data: { id: "gen-abc", total_cost: settled } });
    }
    return sse(stream);
  }) as typeof fetch;
  return calls;
}

let session: OrgSession;
let userId: string;

beforeAll(async () => {
  session = await createOrgSession("chat-spend");
  const [row] = await db.select({ userId: member.userId }).from(member).where(eq(member.organizationId, session.orgId));
  userId = row!.userId;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
});

async function chatRun() {
  const id = `chat_${crypto.randomUUID()}`;
  await db.insert(runs).values({
    id, orgId: session.orgId, userId, prompt: "hi", model: "anthropic/claude-sonnet-5",
    engine: "chat", status: "running", threadId: id,
  });
  return { id, threadId: id, model: "anthropic/claude-sonnet-5" };
}

async function usageEvent(runId: string) {
  await drainProviderEvents(runId);
  const [row] = await db.select({ payload: providerEvents.payload }).from(providerEvents)
    .where(eq(providerEvents.id, `${runId}:chat:usage`));
  return row ? (JSON.parse(row.payload!) as Record<string, unknown>) : null;
}

const house = { value: "house-key", source: "backend_env" as const };
const messages = [{ role: "user" as const, content: "hi" }];

describe("chat turn accounting", () => {
  test("the settled generation figure is read back with the deployment key and wins over the streamed usage", async () => {
    const calls = mockProvider([chunk("Hel"), chunk("lo"), usage(0.2), "[DONE]"], 0.25);
    const run = await chatRun();
    let text = "";
    for await (const delta of chatTurnStream(run, messages, house, new AbortController().signal)) text += delta;
    expect(text).toBe("Hello");
    expect(calls.filter((url) => url.includes("/generation?id=gen-abc"))).toHaveLength(1);
    expect(await usageEvent(run.id)).toMatchObject({
      tokens: { total: 42 }, cost: 0.25, costSource: "provider_generation", generationId: "gen-abc",
    });
    await finalizeRun(run.id, "completed", "Hello", 10);
    const [entry] = await db.select().from(spendEntries).where(eq(spendEntries.chargeKey, run.id));
    expect(entry).toMatchObject({ costUsd: 0.25, tokens: 42, source: "provider_generation" });
  });

  test("a stream that breaks after the provider named the generation is still priced before the caller settles", async () => {
    mockProvider([chunk("Hel"), { error: { message: "upstream reset" } }], 0.05);
    const run = await chatRun();
    let failure: unknown = null;
    try {
      for await (const _delta of chatTurnStream(run, messages, house, new AbortController().signal)) { /* consume */ }
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    // The usage row landed BEFORE the throw reached us: the settlement can read it.
    const [row] = await db.select({ payload: providerEvents.payload }).from(providerEvents)
      .where(eq(providerEvents.id, `${run.id}:chat:usage`));
    expect(JSON.parse(row!.payload!)).toMatchObject({ cost: 0.05, costSource: "provider_generation", generationId: "gen-abc" });
  });

  test("a customer's own key is charged what the stream said and never read back", async () => {
    const calls = mockProvider([chunk("Hi"), usage(0.2), "[DONE]"], 0.25);
    const run = await chatRun();
    for await (const _delta of chatTurnStream(run, messages, { value: "byo", source: "user_connection" }, new AbortController().signal)) { /* consume */ }
    expect(calls.some((url) => url.includes("/generation"))).toBe(false);
    expect(await usageEvent(run.id)).toMatchObject({ cost: 0.2, costSource: "stream_usage" });
  });

  test("a stream with no figure at all is recorded as unpriced, not a silent zero", async () => {
    mockProvider([chunk("Hi"), usage(null), "[DONE]"], null);
    const run = await chatRun();
    for await (const _delta of chatTurnStream(run, messages, house, new AbortController().signal)) { /* consume */ }
    const event = await usageEvent(run.id);
    expect(event).toMatchObject({ costSource: "unpriced", tokens: { total: 42 } });
    expect(event).not.toHaveProperty("cost");
    await finalizeRun(run.id, "completed", "Hi", 10);
    const [entry] = await db.select().from(spendEntries).where(eq(spendEntries.chargeKey, run.id));
    expect(entry).toMatchObject({ costUsd: 0, tokens: 42, source: "unpriced" });
  });
});

describe("POST /api/chat accounting", () => {
  test("a completed turn is charged under its own chat key with the settled figure, and a capped member is refused before any model call", async () => {
    process.env.OPENROUTER_API_KEY = "house-key";
    const spentBefore = (await db.select({ spent: spendAccounts.spentUsd }).from(spendAccounts)
      .where(and(eq(spendAccounts.orgId, session.orgId), eq(spendAccounts.userId, userId))))[0]?.spent ?? 0;
    const calls = mockProvider([chunk("Hi"), usage(0.2), "[DONE]"], 0.25);
    const res = await fetchApi("/api/chat", {
      method: "POST", cookies: session.cookies, body: { messages: [{ role: "user", content: "hello chat" }] },
    });
    expect(res.status).toBe(200);
    const events = await readSse(res, { timeoutMs: 8_000 });
    expect(events.some((event) => event.event === "done")).toBe(true);
    const entry = await waitFor(async () => {
      const [row] = await db.select().from(spendEntries).where(and(
        eq(spendEntries.orgId, session.orgId), eq(spendEntries.userId, userId), like(spendEntries.chargeKey, "chat:%"),
      ));
      return row ?? null;
    });
    expect(entry).toMatchObject({ costUsd: 0.25, tokens: 42, source: "provider_generation" });
    const [account] = await db.select({ spent: spendAccounts.spentUsd }).from(spendAccounts)
      .where(and(eq(spendAccounts.orgId, session.orgId), eq(spendAccounts.userId, userId)));
    expect(account!.spent).toBeCloseTo(spentBefore + 0.25, 6);

    await db.update(spendAccounts).set({ spentUsd: 100 })
      .where(and(eq(spendAccounts.orgId, session.orgId), eq(spendAccounts.userId, userId)));
    const before = calls.length;
    const refused = await json<{ error: string; message: string }>("/api/chat", {
      method: "POST", cookies: session.cookies, body: { messages: [{ role: "user", content: "again" }] },
    });
    expect(refused.status).toBe(402);
    expect(refused.body.error).toBe("spend_allowance_exceeded");
    expect(refused.body.message).toContain("$100.00 of your $100.00");
    expect(calls.length).toBe(before);
  });
});
