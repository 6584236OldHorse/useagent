import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { member, providerEvents, runs, spendAccounts, spendEntries } from "../src/db/schema";
import { settlePendingChatCharges } from "../src/chat/charge-sweep";
import { chargeChatTurn, chatTurnStream, unsettledChatCharges } from "../src/chat/turn";
import { noteSpendGeneration, openSpendCharge } from "../src/runs/spend";
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
  // Internal origin: settled directly, it must leave no learning intent behind.
  await db.insert(runs).values({
    id, orgId: session.orgId, userId, prompt: "hi", model: "anthropic/claude-sonnet-5",
    engine: "chat", status: "running", threadId: id, origin: "internal:e2e",
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

  test("a stream whose generation the provider has not priced yet stays pending with it, never a silent zero, and the sweep prices it from the record", async () => {
    mockProvider([chunk("Hi"), usage(null), "[DONE]"], null);
    const run = await chatRun();
    for await (const _delta of chatTurnStream(run, messages, house, new AbortController().signal)) { /* consume */ }
    const event = await usageEvent(run.id);
    expect(event).toMatchObject({ costSource: "unpriced", tokens: { total: 42 }, generationId: "gen-abc" });
    expect(event).not.toHaveProperty("cost");
    await finalizeRun(run.id, "completed", "Hi", 10);
    const entry = async () => (await db.select().from(spendEntries).where(eq(spendEntries.chargeKey, run.id)))[0];
    expect(await entry()).toMatchObject({ source: "pending", generationId: "gen-abc", costUsd: 0 });
    // The record turns up: the sweep reads it with the deployment key and
    // settles the run at the provider's figure.
    process.env.OPENROUTER_API_KEY = "house-key";
    mockProvider([], 0.31);
    await Bun.sleep(10);
    await settlePendingChatCharges(0);
    expect(await entry()).toMatchObject({ costUsd: 0.31, source: "provider_generation" });
  });
});

describe("chat turns with no figure at all", () => {
  test("a stream that ends normally without naming a generation or usage still counts as one unpriced entry", async () => {
    mockProvider([chunk("Hi", ""), "[DONE]"], null);
    const run = await chatRun();
    for await (const _delta of chatTurnStream(run, messages, house, new AbortController().signal)) { /* consume */ }
    expect(await usageEvent(run.id)).toMatchObject({ costSource: "unpriced", tokens: { total: 0 } });
    await finalizeRun(run.id, "completed", "Hi", 10);
    const [entry] = await db.select().from(spendEntries).where(eq(spendEntries.chargeKey, run.id));
    expect(entry).toMatchObject({ costUsd: 0, tokens: 0, source: "unpriced" });
  });
});

/** This member's chat charges. */
const chatEntries = () => db.select().from(spendEntries)
  .where(and(eq(spendEntries.orgId, session.orgId), eq(spendEntries.userId, userId), like(spendEntries.chargeKey, "chat:%")));

const setSpent = (spentUsd: number) => db.insert(spendAccounts).values({ orgId: session.orgId, userId, spentUsd })
  .onConflictDoUpdate({ target: [spendAccounts.orgId, spendAccounts.userId], set: { spentUsd } });

const spent = async () => (await db.select({ spent: spendAccounts.spentUsd }).from(spendAccounts)
  .where(and(eq(spendAccounts.orgId, session.orgId), eq(spendAccounts.userId, userId))))[0]?.spent ?? 0;

/** Fail this member's next `count` writes to a ledger table with a trigger; the
 *  count lives in a sequence, so it survives the transactions it makes roll
 *  back. Accounts fail on every write; entries only on updates, so a charge
 *  can still be opened. */
async function failWrites(table: "spend_accounts" | "spend_entries", count: number): Promise<() => Promise<void>> {
  const seq = `${table}_fail_seq`;
  const fn = `${table}_fail_writes`;
  await db.execute(sql.raw(`create sequence if not exists ${seq}`));
  await db.execute(sql.raw(`select setval('${seq}', 1, false)`));
  await db.execute(sql.raw(`
    create or replace function ${fn}() returns trigger language plpgsql as $$
    begin
      if nextval('${seq}') <= ${count} then raise exception 'synthetic ${table} write failure'; end if;
      return new;
    end $$`));
  await db.execute(sql.raw(`
    create or replace trigger ${fn} before ${table === "spend_accounts" ? "insert or update" : "update"} on ${table}
    for each row when (new.user_id = '${userId}') execute function ${fn}()`));
  return async () => {
    await db.execute(sql.raw(`drop trigger if exists ${fn} on ${table}`));
  };
}

const ask = (content: string) => fetchApi("/api/chat", { method: "POST", cookies: session.cookies, body: { messages: [{ role: "user", content }] } });

describe("POST /api/chat accounting", () => {
  test("a member's completed stream with no figure is charged as one unpriced entry", async () => {
    process.env.OPENROUTER_API_KEY = "house-key";
    mockProvider([chunk("Hi", ""), "[DONE]"], null);
    const before = await db.select({ key: spendEntries.chargeKey }).from(spendEntries)
      .where(and(eq(spendEntries.orgId, session.orgId), eq(spendEntries.userId, userId), like(spendEntries.chargeKey, "chat:%")));
    const res = await fetchApi("/api/chat", {
      method: "POST", cookies: session.cookies, body: { messages: [{ role: "user", content: "no figure" }] },
    });
    expect(res.status).toBe(200);
    await readSse(res, { timeoutMs: 8_000 });
    const known = new Set(before.map((row) => row.key));
    const entry = await waitFor(async () =>
      (await chatEntries()).find((row) => !known.has(row.chargeKey) && row.source !== "pending") ?? null,
    );
    expect(entry).toMatchObject({ source: "unpriced", costUsd: 0 });
  });

  test("the dev fallback is anonymous: answered on the house key, charged to nobody, capped by nothing", async () => {
    process.env.OPENROUTER_API_KEY = "house-key";
    const calls = mockProvider([chunk("Hi"), usage(0.2), "[DONE]"], 0.25);
    const before = await db.select({ key: spendEntries.chargeKey }).from(spendEntries).where(like(spendEntries.chargeKey, "chat:%"));
    const res = await fetchApi("/api/chat", {
      method: "POST", body: { messages: [{ role: "user", content: "hello from nobody" }] },
    });
    expect(res.status).toBe(200);
    const events = await readSse(res, { timeoutMs: 8_000 });
    expect(events.some((event) => event.event === "done")).toBe(true);
    expect(calls.some((url) => url.includes("/chat/completions"))).toBe(true);
    await Bun.sleep(200);
    const after = await db.select({ key: spendEntries.chargeKey }).from(spendEntries).where(like(spendEntries.chargeKey, "chat:%"));
    expect(after.length).toBe(before.length); // no member behind the request, so no charge
  });

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
      const rows = await db.select().from(spendEntries).where(and(
        eq(spendEntries.orgId, session.orgId), eq(spendEntries.userId, userId), like(spendEntries.chargeKey, "chat:%"),
      ));
      return rows.find((row) => row.source === "provider_generation") ?? null;
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

  test("a charge write that fails once is retried with its figure, and the member is then refused at the cap", async () => {
    process.env.OPENROUTER_API_KEY = "house-key";
    await setSpent(99.9);
    const known = new Set((await chatEntries()).map((row) => row.chargeKey));
    const restore = await failWrites("spend_accounts", 1);
    try {
      mockProvider([chunk("Hi"), usage(0.2), "[DONE]"], 0.25);
      const res = await ask("retry me");
      expect(res.status).toBe(200);
      expect((await readSse(res, { timeoutMs: 8_000 })).some((event) => event.event === "done")).toBe(true);
      const entry = await waitFor(async () =>
        (await chatEntries()).find((row) => !known.has(row.chargeKey) && row.source !== "pending") ?? null,
      );
      expect(entry).toMatchObject({ costUsd: 0.25, tokens: 42, source: "provider_generation", generationId: "gen-abc" });
      expect(await spent()).toBeCloseTo(100.15, 6);
    } finally {
      await restore();
    }
    const refused = await ask("again");
    expect(refused.status).toBe(402);
  });

  test("a settlement the ledger keeps refusing leaves the figure on the entry, and a later sweep settles it from that figure without the provider", async () => {
    process.env.OPENROUTER_API_KEY = "house-key";
    await setSpent(99.9);
    const known = new Set((await chatEntries()).map((row) => row.chargeKey));
    const restore = await failWrites("spend_accounts", 1_000_000);
    let key = "";
    try {
      mockProvider([chunk("Hi"), usage(0.2), "[DONE]"], 0.25);
      const res = await ask("crash me");
      expect(res.status).toBe(200);
      expect((await readSse(res, { timeoutMs: 8_000 })).some((event) => event.event === "done")).toBe(true);
      // The intent was recorded before the model call, the generation noted as
      // the stream named it, and the settled figure stored before the account
      // move the ledger refuses; the settlement retries all fail.
      const pending = await waitFor(async () =>
        (await chatEntries()).find((row) => !known.has(row.chargeKey) && row.figureSource !== null) ?? null,
      );
      expect(pending).toMatchObject({
        source: "pending", figureSource: "provider_generation", costUsd: 0.25, tokens: 42, generationId: "gen-abc",
      });
      key = pending.chargeKey;
      await Bun.sleep(2_000); // past the last settlement retry
      expect((await chatEntries()).find((row) => row.chargeKey === key)).toMatchObject({ source: "pending" });
      expect(await spent()).toBeCloseTo(99.9, 6);
      expect(unsettledChatCharges.get(key)?.figure).toMatchObject({ cost: 0.25, source: "provider_generation" });
    } finally {
      await restore();
    }
    // The process that kept the figure is gone: the sweep settles the entry
    // from the stored figure alone, without asking the provider.
    unsettledChatCharges.delete(key);
    const calls = mockProvider([], null);
    await settlePendingChatCharges(0);
    expect(calls.some((url) => url.includes("/generation"))).toBe(false);
    expect((await chatEntries()).find((row) => row.chargeKey === key)).toMatchObject({ costUsd: 0.25, source: "provider_generation" });
    expect(await spent()).toBeCloseTo(100.15, 6);
    const refused = await ask("again");
    expect(refused.status).toBe(402);
  }, 20_000);

  test("a charge on the member's own key that the ledger refuses is settled by the sweep from the stored figure, never read back", async () => {
    process.env.OPENROUTER_API_KEY = "house-key"; // for the follow-up request's admission, not for this charge
    await setSpent(99.9);
    const key = `chat:${crypto.randomUUID()}`;
    await openSpendCharge({ key, orgId: session.orgId, userId });
    const restore = await failWrites("spend_accounts", 1_000_000);
    const calls = mockProvider([], null);
    try {
      await chargeChatTurn({
        key, orgId: session.orgId, userId, completed: true,
        account: { generationId: "gen-member", usage: { totalTokens: 42, cost: 0.2 } },
        credential: { value: "member-key", source: "user_connection" },
      });
      expect((await chatEntries()).find((row) => row.chargeKey === key)).toMatchObject({
        source: "pending", figureSource: "usage", costUsd: 0.2, tokens: 42, generationId: "gen-member",
      });
    } finally {
      await restore();
    }
    unsettledChatCharges.delete(key); // a restart forgot it
    await settlePendingChatCharges(0);
    expect(calls.some((url) => url.includes("/generation"))).toBe(false);
    expect((await chatEntries()).find((row) => row.chargeKey === key)).toMatchObject({ costUsd: 0.2, source: "usage" });
    expect(await spent()).toBeCloseTo(100.1, 6);
    const refused = await ask("again");
    expect(refused.status).toBe(402);
  }, 20_000);

  test("with the ledger refusing every write, the generation and the figure are kept by this process and land on the next sweep", async () => {
    process.env.OPENROUTER_API_KEY = "house-key";
    await setSpent(99.9);
    const known = new Set((await chatEntries()).map((row) => row.chargeKey));
    const restoreEntries = await failWrites("spend_entries", 1_000_000);
    const restoreAccounts = await failWrites("spend_accounts", 1_000_000);
    let key = "";
    try {
      mockProvider([chunk("Hi"), usage(0.2), "[DONE]"], 0.25);
      const res = await ask("outage");
      expect(res.status).toBe(200);
      expect((await readSse(res, { timeoutMs: 8_000 })).some((event) => event.event === "done")).toBe(true);
      const pending = await waitFor(async () => (await chatEntries()).find((row) => !known.has(row.chargeKey)) ?? null);
      key = pending.chargeKey;
      await Bun.sleep(3_600); // every retry of the note, the figure and the settlement is spent
      expect((await chatEntries()).find((row) => row.chargeKey === key)).toMatchObject({ source: "pending", generationId: null, figureSource: null });
      expect(await spent()).toBeCloseTo(99.9, 6);
      expect(unsettledChatCharges.get(key)).toMatchObject({ generationId: "gen-abc", figure: { cost: 0.25, source: "provider_generation" } });
    } finally {
      await restoreEntries();
      await restoreAccounts();
    }
    // The ledger is back: the next sweep writes what this process kept.
    const calls = mockProvider([], null);
    const swept = await settlePendingChatCharges(0);
    expect(swept.stuck).not.toContain(key);
    expect(calls.some((url) => url.includes("/generation"))).toBe(false);
    expect(unsettledChatCharges.has(key)).toBe(false);
    expect((await chatEntries()).find((row) => row.chargeKey === key)).toMatchObject({ costUsd: 0.25, source: "provider_generation" });
    expect(await spent()).toBeCloseTo(100.15, 6);
    const refused = await ask("again");
    expect(refused.status).toBe(402);
  }, 20_000);

  test("what a dead process left is priced from the provider's record when it can be; what nothing can price is unresolved: reported, counted on the account, shown, and pausing the member until an operator settles it", async () => {
    process.env.OPENROUTER_API_KEY = "house-key";
    await setSpent(0);
    // Three charges a process died on between the generation write and the
    // settlement: one the deployment key can read back, one on the member's
    // own key (the deployment key knows nothing of it), one that never named
    // a generation at all.
    const priced = `chat:${crypto.randomUUID()}`;
    const member = `chat:${crypto.randomUUID()}`;
    const bare = `chat:${crypto.randomUUID()}`;
    await openSpendCharge({ key: priced, orgId: session.orgId, userId });
    await noteSpendGeneration(priced, "gen-crash");
    await openSpendCharge({ key: member, orgId: session.orgId, userId });
    await noteSpendGeneration(member, "gen-member-crash");
    await openSpendCharge({ key: bare, orgId: session.orgId, userId });
    await Bun.sleep(10); // the sweep reads entries opened before its own clock, to the millisecond
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/generation?id=gen-crash")) return Response.json({ data: { id: "gen-crash", total_cost: 0.25 } });
      if (url.includes("/generation?id=")) return new Response("not found", { status: 404 });
      return sse([chunk("Hi", ""), "[DONE]"]);
    }) as typeof fetch;
    const account = async () => (await db.select({ spent: spendAccounts.spentUsd, unresolved: spendAccounts.unresolved }).from(spendAccounts)
      .where(and(eq(spendAccounts.orgId, session.orgId), eq(spendAccounts.userId, userId))))[0]!;

    const swept = await settlePendingChatCharges(0);
    expect(calls.some((url) => url.includes("/generation?id=gen-crash"))).toBe(true);
    expect([...swept.stuck].toSorted()).toEqual([bare, member].toSorted());
    expect((await chatEntries()).find((row) => row.chargeKey === priced)).toMatchObject({ costUsd: 0.25, source: "provider_generation" });
    expect((await chatEntries()).filter((row) => [bare, member].includes(row.chargeKey)).map((row) => row.source)).toEqual(["pending", "pending"]);
    // Unresolved: counted on the account, shown by the figure the composer and
    // Settings read, and admission pauses with a plain message, well under the cap.
    expect(await account()).toEqual({ spent: 0.25, unresolved: 2 });
    expect((await json<{ unresolved: number }>("/api/spend", { cookies: session.cookies })).body.unresolved).toBe(2);
    const refused = await json<{ error: string; message: string }>("/api/chat", {
      method: "POST", cookies: session.cookies, body: { messages: [{ role: "user", content: "again" }] },
    });
    expect(refused.status).toBe(402);
    expect(refused.body.error).toBe("spend_unresolved");
    expect(refused.body.message).toContain("2 chat charges of yours could not be settled");
    expect(calls.some((url) => url.includes("/chat/completions"))).toBe(false);
    // An operator settles them by hand (here: drops them); the next sweep
    // clears the count and the member is admitted again.
    await db.delete(spendEntries).where(inArray(spendEntries.chargeKey, [bare, member]));
    await settlePendingChatCharges(0);
    expect((await account()).unresolved).toBe(0);
    const admitted = await ask("hello again");
    expect(admitted.status).toBe(200);
    expect((await readSse(admitted, { timeoutMs: 8_000 })).some((event) => event.event === "done")).toBe(true);
  });

  test("a chat that lost its stream after the generation id is never settled at zero: the house key prices it at once and a member key leaves it for the sweep, which recovers the same figure", async () => {
    process.env.OPENROUTER_API_KEY = "house-key";
    await setSpent(0);
    mockProvider([], 0.37); // the provider's record of the generation
    const entry = async (key: string) => (await chatEntries()).find((row) => row.chargeKey === key);
    // The deployment key reads the record back and settles the lost stream directly.
    const house = `chat:${crypto.randomUUID()}`;
    await openSpendCharge({ key: house, orgId: session.orgId, userId });
    await chargeChatTurn({
      key: house, orgId: session.orgId, userId,
      account: { generationId: "gen-lost", usage: null },
      credential: { value: "house-key", source: "backend_env" },
    });
    expect(await entry(house)).toMatchObject({ costUsd: 0.37, source: "provider_generation" });
    // A member's own key cannot be read back here: the entry stays pending
    // with its generation, a figure the sweep recovers, never a zero.
    const mine = `chat:${crypto.randomUUID()}`;
    await openSpendCharge({ key: mine, orgId: session.orgId, userId });
    await chargeChatTurn({
      key: mine, orgId: session.orgId, userId,
      account: { generationId: "gen-lost-member", usage: null },
      credential: { value: "member-key", source: "user_connection" },
    });
    expect(await entry(mine)).toMatchObject({ source: "pending", generationId: "gen-lost-member", figureSource: null });
    await Bun.sleep(10);
    await settlePendingChatCharges(0);
    expect(await entry(mine)).toMatchObject({ costUsd: 0.37, source: "provider_generation" });
    expect(await spent()).toBeCloseTo(0.74, 6);
  });

  test("a sweep in flight is joined, not run beside it, so a second call cannot clear a member the first one is marking", async () => {
    process.env.OPENROUTER_API_KEY = "house-key";
    const other = await createOrgSession("chat-spend-other");
    const [otherMember] = await db.select({ userId: member.userId }).from(member).where(eq(member.organizationId, other.orgId));
    const otherUser = otherMember!.userId;
    const unresolvedOf = async (orgId: string, who: string) =>
      (await db.select({ unresolved: spendAccounts.unresolved }).from(spendAccounts)
        .where(and(eq(spendAccounts.orgId, orgId), eq(spendAccounts.userId, who))))[0]?.unresolved ?? 0;
    // X: this member's, with a generation the provider will not price; Y: another member's, with nothing.
    const x = `chat:${crypto.randomUUID()}`;
    await openSpendCharge({ key: x, orgId: session.orgId, userId });
    await noteSpendGeneration(x, "gen-x");
    const y = `chat:${crypto.randomUUID()}`;
    await openSpendCharge({ key: y, orgId: other.orgId, userId: otherUser });
    await Bun.sleep(10);
    const gate = Promise.withResolvers<void>();
    let gated = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/generation?id=gen-x") && gated++ === 0) await gate.promise;
      return new Response("not found", { status: 404 });
    }) as typeof fetch;
    try {
      // Sweep A holds its snapshot and waits on the provider.
      const a = settlePendingChatCharges(0);
      await waitFor(async () => (gated > 0 ? true : null));
      // A second call while A is in flight joins A rather than sweeping beside it.
      const b = settlePendingChatCharges(0);
      await Bun.sleep(300);
      expect(gated).toBe(1); // no second pass asked the provider: the call joined A
      expect(await unresolvedOf(other.orgId, otherUser)).toBe(0);
      gate.resolve();
      expect(await b).toEqual(await a);
      expect(await unresolvedOf(session.orgId, userId)).toBe(1);
      // The next sweep marks Y, and Y's member is refused until it is settled.
      await settlePendingChatCharges(0);
      expect(await unresolvedOf(other.orgId, otherUser)).toBe(1);
      const refused = await json<{ error: string }>("/api/chat", {
        method: "POST", cookies: other.cookies, body: { messages: [{ role: "user", content: "hello" }] },
      });
      expect(refused.status).toBe(402);
      expect(refused.body.error).toBe("spend_unresolved");
    } finally {
      await db.delete(spendEntries).where(inArray(spendEntries.chargeKey, [x, y]));
      await settlePendingChatCharges(0);
    }
    expect(await unresolvedOf(other.orgId, otherUser)).toBe(0);
  });

  test("a run-backed chat on a member key that lost its stream after the generation id settles through the sweep at the provider's figure, never at zero", async () => {
    process.env.OPENROUTER_API_KEY = "house-key";
    await setSpent(0);
    const memberKey = { value: "member-key", source: "user_connection" as const };
    const entry = async (key: string) => (await db.select().from(spendEntries).where(eq(spendEntries.chargeKey, key)))[0];
    // The member's key streams a generation id and text, then loses the stream.
    mockProvider([chunk("Hel", "gen-lost-run"), { error: { message: "upstream reset" } }], 0.37);
    const run = await chatRun();
    await expect((async () => {
      for await (const _delta of chatTurnStream(run, messages, memberKey, new AbortController().signal)) { /* consume */ }
    })()).rejects.toThrow();
    await finalizeRun(run.id, "failed", "stream lost", 10);
    // Finalization leaves the run's charge open with its generation instead of settling a zero.
    expect(await entry(run.id)).toMatchObject({ source: "pending", generationId: "gen-lost-run", costUsd: 0 });
    expect(await spent()).toBeCloseTo(0, 6);
    // The sweep prices it from the provider's record: the figure the house key recovers directly.
    await Bun.sleep(10);
    await settlePendingChatCharges(0);
    expect(await entry(run.id)).toMatchObject({ costUsd: 0.37, source: "provider_generation" });
    expect(await spent()).toBeCloseTo(0.37, 6);
  });

});
