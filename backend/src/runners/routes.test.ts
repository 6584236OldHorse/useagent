import { describe, expect, test } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "../http";
import { DEFAULT_RUNNER_POLICY, type RunnerPolicy } from "./policy";
import { RunnerRegistry } from "./registry";
import { type RunnerRouteDeps, createRunnerRoutes, runnerView } from "./routes";
import { type RunnerRow, hashRunnerToken, mintRunnerToken } from "./store";

function row(overrides: Partial<RunnerRow> = {}): RunnerRow {
  return {
    id: "rn_a",
    orgId: "org-a",
    userId: "user-1",
    name: "laptop",
    platform: "darwin-arm64",
    backend: null,
    version: null,
    protocol: null,
    capacity: {} as RunnerRow["capacity"],
    logins: [],
    imageDigest: null,
    status: "enrolled",
    lastSeenAt: null,
    enrolledAt: new Date("2026-09-08T00:00:00Z"),
    revokedAt: null,
    tokenHash: hashRunnerToken("uart_rn_a.secret"),
    ...overrides,
  };
}

function harness(options: { user?: string; admin?: boolean; rows?: RunnerRow[]; bearer?: boolean } = {}) {
  const rows = new Map((options.rows ?? [row()]).map((r) => [r.id, r] as const));
  let policy: RunnerPolicy = { ...DEFAULT_RUNNER_POLICY };
  const registry = new RunnerRegistry({ persist: { hello: async () => {}, heartbeat: async () => {}, offline: async () => {}, markStale: async () => 0 } });
  for (const r of rows.values()) registry.know(r);
  const scope: MiddlewareHandler<AppEnv> = async (c, next) => {
    c.set("orgId", "org-a");
    c.set("userId", options.user ?? "user-1");
    if (options.bearer) c.set("bearerAuthenticated", true);
    await next();
  };
  const adminScope: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (!options.admin) return c.json({ error: "organization_admin_required" }, 403);
    await next();
  };
  const deps: RunnerRouteDeps = {
    registry,
    enrol: async (input) => {
      const { runnerId, token } = mintRunnerToken();
      const created = row({ id: runnerId, orgId: input.orgId, userId: input.userId, name: input.name, platform: input.platform, tokenHash: hashRunnerToken(token) });
      rows.set(runnerId, created);
      return { runner: created, token };
    },
    list: async (orgId) => [...rows.values()].filter((r) => r.orgId === orgId),
    get: async (orgId, id) => rows.get(id)?.orgId === orgId ? rows.get(id)! : null,
    revoke: async (_orgId, id) => {
      const current = rows.get(id);
      if (!current) return null;
      const revoked = { ...current, status: "revoked" as const, revokedAt: new Date() };
      rows.set(id, revoked);
      return revoked;
    },
    policy: async () => policy,
    setPolicy: async (_orgId, patch) => {
      policy = { ...policy, ...patch };
      return policy;
    },
  };
  const app = new Hono<AppEnv>().route("/api/runners", createRunnerRoutes(deps, scope, adminScope));
  return { app, rows, registry, policy: () => policy };
}

describe("runner routes", () => {
  test("enrol mints a runner id and a one-time token", async () => {
    const { app, rows, registry } = harness();
    const response = await app.request("/api/runners/enrol", { method: "POST", body: JSON.stringify({ name: "  my mac ", platform: "darwin-arm64" }), headers: { "content-type": "application/json" } });
    expect(response.status).toBe(201);
    const body = (await response.json()) as { runnerId: string; token: string };
    expect(body.runnerId).toMatch(/^rn_[a-z2-7]{12}$/);
    expect(body.token).toMatch(new RegExp(`^uart_${body.runnerId}\\.[a-z2-7]{30}$`));
    expect(rows.get(body.runnerId)?.name).toBe("my mac");
    expect(registry.runner(body.runnerId)?.userId).toBe("user-1");
  });

  test("enrol validates its input and refuses API keys", async () => {
    const { app } = harness();
    const bad = await app.request("/api/runners/enrol", { method: "POST", body: JSON.stringify({ name: "x", platform: "amiga" }), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(400);
    const noName = await app.request("/api/runners/enrol", { method: "POST", body: JSON.stringify({ platform: "linux-x64" }), headers: { "content-type": "application/json" } });
    expect(noName.status).toBe(400);
    const notJson = await app.request("/api/runners/enrol", { method: "POST", body: "nope" });
    expect(notJson.status).toBe(400);
    const { app: bearer } = harness({ bearer: true });
    const refused = await bearer.request("/api/runners/enrol", { method: "POST", body: JSON.stringify({ name: "x", platform: "linux-x64" }), headers: { "content-type": "application/json" } });
    expect(refused.status).toBe(403);
  });

  test("list shows the org's machines with their live status", async () => {
    const { app } = harness({ rows: [row(), row({ id: "rn_b", orgId: "org-b" }), row({ id: "rn_c", status: "revoked" })] });
    const response = await app.request("/api/runners");
    const body = (await response.json()) as { id: string; status: string; logins: string[] }[];
    expect(body.map((r) => `${r.id}:${r.status}`)).toEqual(["rn_a:enrolled", "rn_c:revoked"]);
  });

  test("the view reports online only while the registry holds a live link", () => {
    const registry = new RunnerRegistry({ persist: { hello: async () => {}, heartbeat: async () => {}, offline: async () => {}, markStale: async () => 0 } });
    const seen = row({ status: "online", lastSeenAt: new Date() });
    registry.know(seen);
    expect(runnerView(seen, registry).status).toBe("offline");
    expect(runnerView(row({ status: "offline", lastSeenAt: new Date() }), registry).status).toBe("offline");
  });

  test("policy reads for everyone and writes for admins only", async () => {
    const member = harness();
    expect(await (await member.app.request("/api/runners/policy")).json()).toEqual(DEFAULT_RUNNER_POLICY);
    const denied = await member.app.request("/api/runners/policy", { method: "PUT", body: JSON.stringify({ allowLocalLogins: false }), headers: { "content-type": "application/json" } });
    expect(denied.status).toBe(403);
    const admin = harness({ admin: true });
    const updated = await admin.app.request("/api/runners/policy", { method: "PUT", body: JSON.stringify({ allowLocalLogins: false }), headers: { "content-type": "application/json" } });
    expect(await updated.json()).toEqual({ allowLocalExecution: true, allowLocalLogins: false });
    const invalid = await admin.app.request("/api/runners/policy", { method: "PUT", body: JSON.stringify({ allowLocalExecution: "yes" }), headers: { "content-type": "application/json" } });
    expect(invalid.status).toBe(400);
  });

  test("an owner revokes their own machine; another member needs the admin check", async () => {
    const owner = harness();
    const mine = await owner.app.request("/api/runners/rn_a", { method: "DELETE" });
    expect(mine.status).toBe(200);
    expect(owner.rows.get("rn_a")?.status).toBe("revoked");
    expect(owner.registry.runner("rn_a")).toBeNull();
    const other = harness({ user: "user-2" });
    expect((await other.app.request("/api/runners/rn_a", { method: "DELETE" })).status).toBe(403);
    const admin = harness({ user: "user-2", admin: true });
    expect((await admin.app.request("/api/runners/rn_a", { method: "DELETE" })).status).toBe(200);
    expect((await admin.app.request("/api/runners/rn_missing", { method: "DELETE" })).status).toBe(404);
  });
});
