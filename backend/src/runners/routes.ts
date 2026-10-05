// What the frontend calls: enrol this machine, list the organisation's
// machines, revoke one, and read or set the organisation's local-execution
// policy. Org-scoped like every other product route.

import { Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "../http";
import { orgAdminScope, orgScope } from "../middleware/org";
import { DEFAULT_RUNNER_POLICY, type RunnerPolicy, getRunnerPolicy, setRunnerPolicy } from "./policy";
import { type RunnerRegistry, runnerRegistry } from "./registry";
import { type EnrolInput, type RunnerRow, enrolRunner, getRunner, listRunners, revokeRunner } from "./store";

export interface RunnerRouteDeps {
  readonly registry: RunnerRegistry;
  readonly enrol: (input: EnrolInput) => Promise<{ runner: RunnerRow; token: string }>;
  readonly list: (orgId: string) => Promise<RunnerRow[]>;
  readonly get: (orgId: string, runnerId: string) => Promise<RunnerRow | null>;
  readonly revoke: (orgId: string, runnerId: string) => Promise<RunnerRow | null>;
  readonly policy: (orgId: string) => Promise<RunnerPolicy>;
  readonly setPolicy: (orgId: string, policy: Partial<RunnerPolicy>) => Promise<RunnerPolicy>;
}

const PLATFORMS = new Set(["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"]);

export function runnerView(row: RunnerRow, registry: RunnerRegistry) {
  const live = registry.runner(row.id);
  const online = live ? registry.isOnline(live) : false;
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    backend: row.backend,
    version: row.version,
    status: row.status === "revoked" ? "revoked" : online ? "online" : row.status === "enrolled" && !row.lastSeenAt ? "enrolled" : "offline",
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    logins: live?.logins ?? row.logins ?? [],
    capacity: live?.capacity ?? row.capacity ?? null,
    imageDigest: live?.imageDigest ?? row.imageDigest,
    ownerUserId: row.userId,
  };
}

export function createRunnerRoutes(
  deps: RunnerRouteDeps,
  scope: MiddlewareHandler<AppEnv> = orgScope,
  adminScope: MiddlewareHandler<AppEnv> = orgAdminScope,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use("*", scope);

  routes.post("/enrol", async (c) => {
    const orgId = c.get("orgId");
    const userId = c.get("userId");
    if (!orgId || !userId) return c.json({ error: "forbidden" }, 403);
    if (c.get("bearerAuthenticated")) return c.json({ error: "forbidden" }, 403);
    let body: { name?: unknown; platform?: unknown };
    try {
      body = (await c.req.json()) as { name?: unknown; platform?: unknown };
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 80) : "";
    const platform = typeof body.platform === "string" ? body.platform.trim() : "";
    if (!name) return c.json({ error: "name is required" }, 400);
    if (!PLATFORMS.has(platform)) return c.json({ error: `platform must be one of ${[...PLATFORMS].join(", ")}` }, 400);
    const { runner, token } = await deps.enrol({ orgId, userId, name, platform });
    deps.registry.know(runner);
    return c.json({ runnerId: runner.id, token }, 201);
  });

  routes.get("/", async (c) => {
    const rows = await deps.list(c.get("orgId"));
    return c.json(rows.map((row) => runnerView(row, deps.registry)));
  });

  routes.get("/policy", async (c) => {
    return c.json(await deps.policy(c.get("orgId")));
  });

  routes.put("/policy", adminScope, async (c) => {
    let body: Partial<RunnerPolicy>;
    try {
      body = (await c.req.json()) as Partial<RunnerPolicy>;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    const patch: { allowLocalExecution?: boolean; allowLocalLogins?: boolean } = {};
    for (const key of Object.keys(DEFAULT_RUNNER_POLICY) as (keyof RunnerPolicy)[]) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== "boolean") return c.json({ error: `${key} must be a boolean` }, 400);
      patch[key] = body[key];
    }
    return c.json(await deps.setPolicy(c.get("orgId"), patch));
  });

  routes.delete("/:id", async (c) => {
    const orgId = c.get("orgId");
    const userId = c.get("userId");
    const row = await deps.get(orgId, c.req.param("id"));
    if (!row) return c.json({ error: "not_found" }, 404);
    // The owner may revoke their own machine; anyone else needs the admin check.
    if (row.userId !== userId) {
      const gate = await adminScope(c, async () => {});
      if (gate) return gate;
    }
    const revoked = await deps.revoke(orgId, row.id);
    deps.registry.forget(row.id);
    return c.json({ id: row.id, status: revoked?.status ?? "revoked" });
  });

  return routes;
}

export const runnerRoutes = createRunnerRoutes({
  registry: runnerRegistry,
  enrol: enrolRunner,
  list: listRunners,
  get: getRunner,
  revoke: revokeRunner,
  policy: getRunnerPolicy,
  setPolicy: setRunnerPolicy,
});
