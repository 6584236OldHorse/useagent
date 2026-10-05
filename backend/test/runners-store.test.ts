import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { runners } from "../src/db/schema";
import { getRunnerPolicy, setRunnerPolicy } from "../src/runners/policy";
import { RunnerRegistry } from "../src/runners/registry";
import {
  enrolRunner,
  getRunner,
  hashRunnerToken,
  listRunners,
  markStaleRunnersOffline,
  recordHeartbeat,
  recordHello,
  recordOffline,
  revokeRunner,
  runnerForToken,
} from "../src/runners/store";
import "./helpers";

const ORG = `org-runners-${crypto.randomUUID().slice(0, 8)}`;

describe("runner store", () => {
  test("enrol, resolve by token, list, revoke", async () => {
    const { runner, token } = await enrolRunner({ orgId: ORG, userId: "user-1", name: "laptop", platform: "darwin-arm64" });
    expect(runner.id).toMatch(/^rn_/);
    expect(runner.tokenHash).toBe(hashRunnerToken(token));
    expect(runner.status).toBe("enrolled");
    expect((await runnerForToken(token))?.id).toBe(runner.id);
    expect(await runnerForToken(`${token}x`)).toBeNull();
    expect((await listRunners(ORG)).map((r) => r.id)).toEqual([runner.id]);
    expect((await getRunner(ORG, runner.id))?.name).toBe("laptop");
    expect(await getRunner("other-org", runner.id)).toBeNull();

    await recordHello(runner.id, {
      t: "hello",
      runnerId: runner.id,
      version: "0.1.0",
      protocol: 1,
      backend: "apple",
      platform: "darwin-arm64",
      capacity: { cpu: 8, memoryMb: 16384, sandboxes: 0 },
      logins: ["codex"],
      imageDigest: null,
    });
    let row = (await getRunner(ORG, runner.id))!;
    expect(row.status).toBe("online");
    expect(row.backend).toBe("apple");
    expect(row.capacity).toEqual({ cpu: 8, memoryMb: 16384, sandboxes: 0 });
    expect(row.lastSeenAt).not.toBeNull();

    await recordHeartbeat(runner.id, { cpu: 8, memoryMb: 16384, sandboxes: 1 }, ["codex", "claude"], "sha256:abc");
    row = (await getRunner(ORG, runner.id))!;
    expect(row.logins).toEqual(["codex", "claude"]);
    expect(row.imageDigest).toBe("sha256:abc");

    expect(await markStaleRunnersOffline([runner.id])).toBe(0);
    expect(await markStaleRunnersOffline([])).toBeGreaterThanOrEqual(1);
    expect((await getRunner(ORG, runner.id))?.status).toBe("offline");
    await recordHello(runner.id, { t: "hello", runnerId: runner.id, version: "0.1.0", protocol: 1, backend: "docker", platform: "linux-x64", capacity: { cpu: 1, memoryMb: 1024, sandboxes: 0 }, logins: [], imageDigest: null });
    await recordOffline(runner.id);
    expect((await getRunner(ORG, runner.id))?.status).toBe("offline");

    expect((await revokeRunner(ORG, runner.id))?.status).toBe("revoked");
    expect(await runnerForToken(token)).toBeNull();
    expect(await revokeRunner(ORG, "rn_missing")).toBeNull();
  });

  test("the registry loads enrolled runners as known but offline", async () => {
    const { runner } = await enrolRunner({ orgId: ORG, userId: "user-2", name: "desk", platform: "linux-x64" });
    await db.update(runners).set({ status: "online", lastSeenAt: new Date() }).where(eq(runners.id, runner.id));
    const registry = new RunnerRegistry();
    expect(await registry.load()).toBeGreaterThanOrEqual(1);
    const live = registry.runner(runner.id)!;
    expect(live.userId).toBe("user-2");
    expect(live.enrolledAt).toBe(runner.enrolledAt.toISOString());
    expect(registry.isOnline(live)).toBe(false);
    expect(registry.onlineForUser(ORG, "user-2")).toBeNull();
    // A previous process left it online; loading without a live link marks it offline.
    expect((await getRunner(ORG, runner.id))?.status).toBe("offline");
    expect(registry.directory.get(runner.id)?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the org policy defaults to allow and persists a change", async () => {
    expect(await getRunnerPolicy(ORG)).toEqual({ allowLocalExecution: true, allowLocalLogins: true });
    expect(await setRunnerPolicy(ORG, { allowLocalLogins: false })).toEqual({ allowLocalExecution: true, allowLocalLogins: false });
    expect(await getRunnerPolicy(ORG)).toEqual({ allowLocalExecution: true, allowLocalLogins: false });
    expect(await setRunnerPolicy(ORG, { allowLocalExecution: false })).toEqual({ allowLocalExecution: false, allowLocalLogins: false });
  });
});
