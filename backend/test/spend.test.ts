import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { member, providerEvents, runs, spendAccounts, spendEntries } from "../src/db/schema";
import { finalizeRun } from "../src/runs/finalize";
import { accrueRunSpend, spendAllowanceDefaultUsd } from "../src/runs/spend";
import { providerKeyLimitReason } from "../src/provider-gateway/key-limit";
import { createOrgSession, fetchApi, json, uid, type OrgSession } from "./helpers";

// Spend allowance: accrual from real step-finish cost at settlement, the per-run
// double-count guard, the hard cap at acceptance (with keyed replays and the
// kill switch), org-scoped ledgers, and GET /api/spend. Runs use the scripted
// `mock` engine (no sandbox).

let session: OrgSession;
let userId: string;

beforeAll(async () => {
  session = await createOrgSession("spend");
  const [row] = await db
    .select({ userId: member.userId })
    .from(member)
    .where(eq(member.organizationId, session.orgId));
  userId = row!.userId;
});

afterEach(() => {
  delete process.env.SPEND_ALLOWANCE_USD;
});

async function account(orgId = session.orgId) {
  const [row] = await db
    .select({ spent: spendAccounts.spentUsd, runs: spendAccounts.runs, allowance: spendAccounts.allowanceUsd })
    .from(spendAccounts)
    .where(and(eq(spendAccounts.orgId, orgId), eq(spendAccounts.userId, userId)));
  return row ?? null;
}

async function settledRun(id: string, costs: Array<{ cost: number; costSource?: string }>) {
  await db.insert(runs).values({
    id, orgId: session.orgId, userId, prompt: "price me", model: "claude-opus-5",
    engine: "opencode", status: "running", threadId: id,
  });
  await db.insert(providerEvents).values(
    costs.map((payload, seq) => ({
      id: `${id}-usage-${seq}`, runId: id, threadId: id, seq, provider: "opencode",
      eventType: "part.step-finish", nativeMessageId: `m${seq}`, nativePartId: `p${seq}`,
      payload: JSON.stringify({ type: "step-finish", tokens: { total: 100 }, ...payload }),
    })),
  );
  return { id, orgId: session.orgId, userId };
}

function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return json<{ id?: string; error?: string; message?: string; spent?: number; allowance?: number }>(
    "/api/runs",
    { method: "POST", body, headers, cookies: session.cookies },
  );
}

describe("spend allowance", () => {
  test("the default is $100 and 0 (or junk) turns the cap off", () => {
    expect(spendAllowanceDefaultUsd({})).toBe(100);
    expect(spendAllowanceDefaultUsd({ SPEND_ALLOWANCE_USD: "250.5" })).toBe(250.5);
    expect(spendAllowanceDefaultUsd({ SPEND_ALLOWANCE_USD: "0" })).toBe(0);
    expect(spendAllowanceDefaultUsd({ SPEND_ALLOWANCE_USD: "lots" })).toBe(0);
  });

  test("settling a run charges the sum of its step-finish cost exactly once", async () => {
    const before = (await account())?.spent ?? 0;
    const run = await settledRun(`spend_${uid()}`, [{ cost: 0.0125 }, { cost: 0.02 }, {}]);
    const first = await finalizeRun(run.id, "completed", "done", 10);
    expect(first.applied).toBe(true);
    const charged = await account();
    expect(charged!.spent).toBeCloseTo(before + 0.0325, 6);
    const [entry] = await db.select().from(spendEntries).where(eq(spendEntries.runId, run.id));
    expect(entry!.costUsd).toBeCloseTo(0.0325, 6);
    expect(entry!.source).toBe("step_finish");

    // A second finalize is a no-op, and a repeated accrual of the same run
    // (parallel, no transaction) inserts nothing and charges nothing.
    expect((await finalizeRun(run.id, "failed", "again", 10)).applied).toBe(false);
    await Promise.all([accrueRunSpend(run, db), accrueRunSpend(run, db)]);
    expect((await account())!.spent).toBeCloseTo(charged!.spent, 6);
    expect((await account())!.runs).toBe(charged!.runs);
  });

  test("a failed turn still spent, and the provider's settled figure is recorded as the winner", async () => {
    const before = (await account())?.spent ?? 0;
    const run = await settledRun(`spend_${uid()}`, [{ cost: 0.5, costSource: "provider_generation" }]);
    await finalizeRun(run.id, "failed", "engine error", 10);
    expect((await account())!.spent).toBeCloseTo(before + 0.5, 6);
    const [entry] = await db.select().from(spendEntries).where(eq(spendEntries.runId, run.id));
    expect(entry!.source).toBe("provider_generation");
  });

  test("a member at the allowance is refused new work with the figures, replays and the kill switch still pass", async () => {
    const key = uid("spend-key");
    const accepted = await post({ prompt: "before the cap", engine: "mock" }, { "Idempotency-Key": key });
    expect(accepted.status).toBe(201);

    await db.insert(spendAccounts).values({ orgId: session.orgId, userId, spentUsd: 100 })
      .onConflictDoUpdate({ target: [spendAccounts.orgId, spendAccounts.userId], set: { spentUsd: 100 } });

    const refused = await post({ prompt: "over the cap", engine: "mock" });
    expect(refused.status).toBe(402);
    expect(refused.body.error).toBe("spend_allowance_exceeded");
    expect(refused.body.message).toBe(
      "You have spent $100.00 of your $100.00 allowance. New tasks are paused until it is raised.",
    );
    expect(refused.body).toMatchObject({ spent: 100, allowance: 100 });

    // The follow-up ingress refuses the same way.
    const reply = await json<{ error?: string }>(
      `/api/threads/${accepted.body.id}/messages`,
      { method: "POST", body: { text: "and again" }, headers: { "Idempotency-Key": uid("spend-reply") }, cookies: session.cookies },
    );
    expect(reply.status).toBe(402);
    expect(reply.body.error).toBe("spend_allowance_exceeded");

    // A keyed replay is a read of the original decision, not new work.
    const replay = await post({ prompt: "before the cap", engine: "mock" }, { "Idempotency-Key": key });
    expect(replay).toMatchObject({ status: 200, body: { id: accepted.body.id } });

    // GET /api/spend shows the member's own figures.
    const mine = await json<{ spent: number; allowance: number | null }>("/api/spend", { cookies: session.cookies });
    expect(mine.status).toBe(200);
    expect(mine.body.spent).toBeCloseTo(100, 6);
    expect(mine.body.allowance).toBe(100);

    // Kill switch: no cap, and the snapshot says so.
    process.env.SPEND_ALLOWANCE_USD = "0";
    expect((await post({ prompt: "cap is off", engine: "mock" })).status).toBe(201);
    expect((await json<{ allowance: number | null }>("/api/spend", { cookies: session.cookies })).body.allowance).toBeNull();
    delete process.env.SPEND_ALLOWANCE_USD;

    // The ledger is per organisation: the same person in a second org starts fresh.
    const create = await fetchApi("/api/auth/organization/create", {
      method: "POST", cookies: session.cookies, body: { name: "Second org", slug: uid("slug") },
    });
    expect(create.status).toBe(200);
    session.jar.absorb(create);
    const created = (await create.json()) as { id?: string; organization?: { id?: string } };
    const otherOrgId = created.id ?? created.organization?.id!;
    const setActive = await fetchApi("/api/auth/organization/set-active", {
      method: "POST", cookies: session.jar.header(), body: { organizationId: otherOrgId },
    });
    expect(setActive.status).toBe(200);
    session.jar.absorb(setActive);
    session = { ...session, cookies: session.jar.header() };
    expect((await post({ prompt: "fresh ledger", engine: "mock" })).status).toBe(201);
    const other = await json<{ spent: number }>("/api/spend", { cookies: session.cookies });
    expect(other.body.spent).toBe(0);
  });

  test("a spent provider key is named plainly, other errors are not", () => {
    expect(providerKeyLimitReason('openrouter 403: {"error":{"message":"Key limit exceeded","code":403}}'))
      .toContain("reached its spending limit");
    expect(providerKeyLimitReason("upstream returned 503")).toBeNull();
  });
});
