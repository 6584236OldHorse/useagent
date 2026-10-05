import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, like, sql } from "drizzle-orm";
import type { SandboxProvider } from "@useagent/sandbox-contract";
import { db } from "../src/db/client";
import { member, runs, sandboxMinutesEntries } from "../src/db/schema";
import { createLease } from "../src/fleet/lease-repo";
import { finalizeRun } from "../src/runs/finalize";
import { acceptRunCancel } from "../src/commands/cancel";
import { acceptProductChildBatch } from "../src/runs/child-thread-batch-service";
import {
  accrueRunSandboxMinutes,
  SandboxMinutesExceededError,
  sandboxMinutesPerUser,
} from "../src/runs/sandbox-minutes";
import { resolveSandboxBindingForRun, type SandboxBinding } from "../src/sandboxes/binding";
import { enabledSandboxProviders } from "../src/sandboxes/preference";
import { createOrgSession, json, uid, type OrgSession } from "./helpers";

// Sandbox minutes: accrual at settlement from the capacity leases a run held
// (a run that moved to a second sandbox is charged both), the per-run
// double-count guard, the cap at every acceptance (runs, thread replies, fleet
// batches, child batches) with keyed replays and the kill switch, GET
// /api/sandbox-minutes, and the member's preferred provider among the enabled
// ones with the deployment default as the fallback.

let session: OrgSession;
let userId: string;

async function memberOf(orgId: string): Promise<string> {
  const [row] = await db.select({ userId: member.userId }).from(member).where(eq(member.organizationId, orgId));
  return row!.userId;
}

beforeAll(async () => {
  session = await createOrgSession("minutes");
  userId = await memberOf(session.orgId);
});

afterEach(() => {
  delete process.env.SANDBOX_MINUTES_PER_USER;
});

async function runRow(id: string, sandboxId: string | null, status: "running" | "queued" = "running") {
  await db.insert(runs).values({
    id, orgId: session.orgId, userId, prompt: "hold a sandbox", model: "mock-model",
    engine: "mock", status, threadId: id, sandboxId,
  });
}

function lease(runId: string, sandboxId: string | null) {
  return createLease({
    runId, threadId: runId, orgId: session.orgId, provider: "daytona", tier: "standard",
    cpuMillicores: 2_000, memoryMib: 8_192, leaseTtlMs: 60_000, sandboxId,
  });
}

async function entry(chargeKey: string) {
  const [row] = await db.select().from(sandboxMinutesEntries).where(eq(sandboxMinutesEntries.chargeKey, chargeKey));
  return row ?? null;
}

async function seedUsed(orgId: string, user: string, minutes: number) {
  await db.insert(sandboxMinutesEntries).values({
    chargeKey: `seed_${uid()}`, orgId, userId: user, seconds: minutes * 60, sandboxes: 1,
  });
}

function post(body: Record<string, unknown>, headers: Record<string, string> = {}, cookies = session.cookies) {
  return json<{ id?: string; error?: string; message?: string; used?: number; cap?: number }>(
    "/api/runs",
    { method: "POST", body, headers, cookies },
  );
}

describe("sandbox minutes", () => {
  test("the default is 600 minutes and 0 (or junk) turns the cap off", () => {
    expect(sandboxMinutesPerUser({})).toBe(600);
    expect(sandboxMinutesPerUser({ SANDBOX_MINUTES_PER_USER: "90" })).toBe(90);
    expect(sandboxMinutesPerUser({ SANDBOX_MINUTES_PER_USER: "12.9" })).toBe(12);
    expect(sandboxMinutesPerUser({ SANDBOX_MINUTES_PER_USER: "0" })).toBe(0);
    expect(sandboxMinutesPerUser({ SANDBOX_MINUTES_PER_USER: "lots" })).toBe(0);
  });

  test("settling a run charges the lifetimes of both sandboxes it held, exactly once", async () => {
    const id = `minutes_${uid()}`;
    await runRow(id, "sb-second");
    // The first sandbox was lost after a minute of the run; its lease was
    // released then and a second one was granted for the replacement box.
    const first = await lease(id, "sb-first");
    await db.execute(sql`
      update sandbox_leases set state = 'released',
        created_at = now() - interval '150 seconds', updated_at = now() - interval '90 seconds'
      where id = ${first}`);
    const second = await lease(id, "sb-second");
    await db.execute(sql`update sandbox_leases set created_at = now() - interval '120 seconds' where id = ${second}`);

    expect((await finalizeRun(id, "failed", "engine error", 10)).applied).toBe(true);
    const charged = await entry(id);
    expect(charged).toMatchObject({ orgId: session.orgId, userId, sandboxes: 2 });
    expect(charged!.seconds).toBeGreaterThanOrEqual(180);
    expect(charged!.seconds).toBeLessThanOrEqual(185);
    // The settlement released the second lease; the charge read its release time.
    const states = await db.execute(sql`select state from sandbox_leases where run_id = ${id}`);
    expect(states.map((row) => row.state)).toEqual(["released", "released"]);

    const mine = await json<{ used: number; cap: number | null; runs: number }>("/api/sandbox-minutes", { cookies: session.cookies });
    expect(mine.status).toBe(200);
    expect(mine.body).toEqual({ used: 3, cap: 600, runs: 1 });

    // A second finalize is a no-op and a repeated accrual inserts nothing.
    expect((await finalizeRun(id, "completed", "again", 10)).applied).toBe(false);
    expect(await accrueRunSandboxMinutes({ id, orgId: session.orgId, userId, sandboxId: "sb-second" }, db)).toBe(false);
    expect(await db.select().from(sandboxMinutesEntries).where(eq(sandboxMinutesEntries.chargeKey, id))).toHaveLength(1);
  });

  test("a completed run is charged too; a run that never held a sandbox leaves no entry", async () => {
    const completed = `minutes_${uid()}`;
    await runRow(completed, null);
    const held = await lease(completed, "sb-only");
    await db.execute(sql`update sandbox_leases set created_at = now() - interval '61 seconds' where id = ${held}`);
    expect((await finalizeRun(completed, "completed", "done", 10)).applied).toBe(true);
    expect(await entry(completed)).toMatchObject({ sandboxes: 1 });
    expect((await entry(completed))!.seconds).toBeGreaterThanOrEqual(61);

    // A chat or mock turn takes a capacity lease but never a sandbox.
    const bare = `minutes_${uid()}`;
    await runRow(bare, null);
    await lease(bare, null);
    expect((await finalizeRun(bare, "completed", "done", 10)).applied).toBe(true);
    expect(await entry(bare)).toBeNull();
  });

  test("a Stop on a queued run that already holds its thread's retained sandbox charges that lease", async () => {
    const id = `minutes_${uid()}`;
    await runRow(id, "sb-retained", "queued");
    // Admission granted the lease on the retained sandbox; the worker had not
    // marked the run running when the person pressed Stop.
    const held = await lease(id, "sb-retained");
    await db.execute(sql`update sandbox_leases set created_at = now() - interval '30 seconds' where id = ${held}`);
    const stopped = await acceptRunCancel({ orgId: session.orgId, actorId: userId, runId: id });
    expect(stopped).toMatchObject({ status: "accepted", runStatusWas: "queued" });
    const charged = await entry(id);
    expect(charged).toMatchObject({ sandboxes: 1 });
    expect(charged!.seconds).toBeGreaterThanOrEqual(30);
    // The cancel was the settlement: a later finalize applies nothing and charges nothing more.
    expect((await finalizeRun(id, "completed", "late", 10)).applied).toBe(false);
    expect(await db.select().from(sandboxMinutesEntries).where(eq(sandboxMinutesEntries.chargeKey, id))).toHaveLength(1);
  });

  test("whole seconds are the floor of the lease lifetimes, so a fraction never rounds a member into a minute early", async () => {
    process.env.SANDBOX_MINUTES_PER_USER = "1";
    const fresh = await createOrgSession("minutes-floor");
    const freshUser = await memberOf(fresh.orgId);
    const id = `minutes_${uid()}`;
    await db.insert(runs).values({
      id, orgId: fresh.orgId, userId: freshUser, prompt: "almost a minute", model: "mock-model",
      engine: "mock", status: "running", threadId: id, sandboxId: "sb-short",
    });
    const held = await createLease({
      runId: id, threadId: id, orgId: fresh.orgId, provider: "daytona", tier: "standard",
      cpuMillicores: 2_000, memoryMib: 8_192, leaseTtlMs: 60_000, sandboxId: "sb-short",
    });
    await db.execute(sql`update sandbox_leases set created_at = now() - interval '59.5 seconds' where id = ${held}`);
    expect((await finalizeRun(id, "failed", "engine error", 10)).applied).toBe(true);
    expect((await entry(id))!.seconds).toBe(59);
    const mine = await json<{ used: number; cap: number | null }>("/api/sandbox-minutes", { cookies: fresh.cookies });
    expect(mine.body).toMatchObject({ used: 0, cap: 1 });
    expect((await post({ prompt: "still under the cap", engine: "mock" }, {}, fresh.cookies)).status).toBe(201);
  });

  test("a member at the cap is refused new work with the figures; replays and the kill switch still pass", async () => {
    process.env.SANDBOX_MINUTES_PER_USER = "10";
    const capped = await createOrgSession("minutes-cap");
    const cappedUser = await memberOf(capped.orgId);
    const key = uid("minutes-key");
    const accepted = await post({ prompt: "before the cap", engine: "mock" }, { "Idempotency-Key": key }, capped.cookies);
    expect(accepted.status).toBe(201);

    await seedUsed(capped.orgId, cappedUser, 10);

    const refused = await post({ prompt: "over the cap", engine: "mock" }, {}, capped.cookies);
    expect(refused.status).toBe(402);
    expect(refused.body.error).toBe("sandbox_minutes_exceeded");
    expect(refused.body.message).toBe(
      "You have used 10 of your 10 sandbox minutes. New tasks are paused until the cap is raised.",
    );
    expect(refused.body).toMatchObject({ used: 10, cap: 10 });

    // The follow-up ingress refuses the same way.
    const reply = await json<{ error?: string }>(
      `/api/threads/${accepted.body.id}/messages`,
      { method: "POST", body: { text: "and again" }, headers: { "Idempotency-Key": uid("minutes-reply") }, cookies: capped.cookies },
    );
    expect(reply.status).toBe(402);
    expect(reply.body.error).toBe("sandbox_minutes_exceeded");

    // A keyed replay is a read of the original decision, not new work.
    const replay = await post({ prompt: "before the cap", engine: "mock" }, { "Idempotency-Key": key }, capped.cookies);
    expect(replay).toMatchObject({ status: 200, body: { id: accepted.body.id } });

    const mine = await json<{ used: number; cap: number | null }>("/api/sandbox-minutes", { cookies: capped.cookies });
    expect(mine.body).toMatchObject({ used: 10, cap: 10 });

    // The ledger is per organisation: the same person's first org is untouched.
    expect((await json<{ used: number }>("/api/sandbox-minutes", { cookies: session.cookies })).body.used).toBeLessThan(10);

    // Kill switch: no cap, and the snapshot says so.
    process.env.SANDBOX_MINUTES_PER_USER = "0";
    expect((await post({ prompt: "cap is off", engine: "mock" }, {}, capped.cookies)).status).toBe(201);
    expect((await json<{ cap: number | null }>("/api/sandbox-minutes", { cookies: capped.cookies })).body.cap).toBeNull();
  });

  test("fleet batches and delegated child batches refuse a capped member inside their own acceptance", async () => {
    process.env.SANDBOX_MINUTES_PER_USER = "10";
    const batchSession = await createOrgSession("minutes-batches");
    const batchUser = await memberOf(batchSession.orgId);
    const parent = await post({ prompt: "parent before the cap", engine: "mock" }, {}, batchSession.cookies);
    expect(parent.status).toBe(201);
    await seedUsed(batchSession.orgId, batchUser, 10);

    const previousRollout = process.env.FLEET_BATCH_ROLLOUT;
    process.env.FLEET_BATCH_ROLLOUT = "write";
    let batch;
    try {
      batch = await json<{ error?: string; message?: string }>("/api/fleet/batches", {
        method: "POST", cookies: batchSession.cookies, headers: { "Idempotency-Key": uid("minutes-batch") },
        body: { tasks: [{ prompt: "fan out", engine: "mock" }] },
      });
    } finally {
      if (previousRollout === undefined) delete process.env.FLEET_BATCH_ROLLOUT;
      else process.env.FLEET_BATCH_ROLLOUT = previousRollout;
    }
    expect(batch.status).toBe(402);
    expect(batch.body.error).toBe("sandbox_minutes_exceeded");
    expect(batch.body.message).toContain("10 of your 10 sandbox minutes");

    await expect(acceptProductChildBatch({
      orgId: batchSession.orgId, actorId: batchUser, parentRunId: parent.body.id!, parentThreadId: parent.body.id!,
      idempotencyKey: uid("minutes-children"), children: [{ title: "child", prompt: "delegate this" }],
    })).rejects.toBeInstanceOf(SandboxMinutesExceededError);
    expect(await db.select().from(runs).where(and(eq(runs.orgId, batchSession.orgId), like(runs.prompt, "delegate%")))).toHaveLength(0);
  });
});

describe("preferred sandbox provider", () => {
  const fakeProvider = (label: string): SandboxProvider => ({ label } as unknown as SandboxProvider);
  const envBinding: SandboxBinding = { kind: "daytona", provider: fakeProvider("env"), snapshot: null, credential: "env", userId: null, logins: [] };

  test("the enabled providers are the deployment default plus every vendor with a credential set", () => {
    expect(enabledSandboxProviders({})).toEqual(["daytona"]);
    expect(enabledSandboxProviders({ CUBE_API_KEY: "c" })).toEqual(["daytona", "cube"]);
    expect(enabledSandboxProviders({ SANDBOX_PROVIDER: "cube", DAYTONA_API_KEY: "d", BOX_API_KEY: "b" })).toEqual(["daytona", "cube", "box"]);
    expect(enabledSandboxProviders({ SANDBOX_PROVIDER: "box" })).toEqual(["box"]);
  });

  test("a stored preference picks that provider for new sandboxes, and anything else falls back to the default", async () => {
    const previousCube = process.env.CUBE_API_KEY;
    process.env.CUBE_API_KEY = "cube_deployment";
    const scope = { orgId: session.orgId, userId };
    const get = () => json<{ provider: string | null; defaultProvider: string; enabled: Array<{ kind: string; label: string }> }>(
      "/api/sandbox-preference", { cookies: session.cookies },
    );
    const put = (provider: string | null) => json<{ provider?: string | null; error?: string }>(
      "/api/sandbox-preference", { method: "PUT", body: { provider }, cookies: session.cookies },
    );
    try {
      expect((await get()).body).toMatchObject({ provider: null, defaultProvider: "daytona" });
      expect((await get()).body.enabled.map((p) => p.kind)).toEqual(["daytona", "cube"]);
      // The E2B-protocol plugin keeps its id; the dropdown's name follows where CUBE_API_URL points.
      const previousUrl = process.env.CUBE_API_URL;
      process.env.CUBE_API_URL = "https://api.e2b.app";
      expect((await get()).body.enabled.find((p) => p.kind === "cube")?.label).toBe("E2B");
      process.env.CUBE_API_URL = "https://cube.internal.example";
      expect((await get()).body.enabled.find((p) => p.kind === "cube")?.label).toBe("Cube");
      if (previousUrl === undefined) delete process.env.CUBE_API_URL;
      else process.env.CUBE_API_URL = previousUrl;
      // Only an enabled hosted provider may be preferred; a machine is never picked here.
      expect((await put("box")).status).toBe(400);
      expect((await put("local")).status).toBe(400);
      expect((await put("nonsense")).status).toBe(400);
      expect((await put("cube")).body.provider).toBe("cube");
      // Only an explicit provider changes the stored choice: a body without one,
      // an array, or unparsable JSON is refused and clears nothing.
      const raw = (body: string) => json<{ error?: string }>(
        "/api/sandbox-preference",
        { method: "PUT", body, headers: { "content-type": "application/json" }, cookies: session.cookies },
      );
      expect((await raw("{}")).status).toBe(400);
      expect((await raw("[]")).status).toBe(400);
      expect((await raw("not json")).status).toBe(400);
      expect((await get()).body.provider).toBe("cube");
      // A vendor whose credential was removed since is not what runs; the view says so.
      delete process.env.CUBE_API_KEY;
      expect((await get()).body).toMatchObject({ provider: null, defaultProvider: "daytona" });
      process.env.CUBE_API_KEY = "cube_deployment";
      expect((await get()).body.provider).toBe("cube");

      const built: string[] = [];
      const deps = {
        env: { CUBE_API_KEY: "cube_deployment" },
        envProvider: () => envBinding,
        providers: { cube: (key: string) => { built.push(key); return fakeProvider("cube"); } },
      };
      const binding = await resolveSandboxBindingForRun(scope, deps);
      expect(binding).toMatchObject({ kind: "cube", credential: "env", userId: null });
      expect(built).toEqual(["cube_deployment"]);
      // Without the credential here (another deployment), the preference is ignored.
      expect(await resolveSandboxBindingForRun(scope, { env: {}, envProvider: () => envBinding })).toBe(envBinding);
      // Another member has no preference.
      expect(await resolveSandboxBindingForRun({ orgId: session.orgId, userId: "someone-else" }, deps)).toBe(envBinding);
      // Cleared: back to the default.
      expect((await put(null)).body.provider).toBeNull();
      expect(await resolveSandboxBindingForRun(scope, deps)).toBe(envBinding);
    } finally {
      if (previousCube === undefined) delete process.env.CUBE_API_KEY;
      else process.env.CUBE_API_KEY = previousCube;
    }
  });
});
