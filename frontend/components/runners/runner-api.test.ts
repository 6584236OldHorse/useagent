import { describe, expect, test } from "bun:test";
import {
  canManageRunnerPolicy,
  enrolRunner,
  fetchRunnerEnabled,
  fetchRunnerPolicy,
  fetchRunners,
  revokeRunner,
  updateRunnerPolicy,
} from "./runner-api";

const runner = {
  id: "rn_a",
  name: "Desk Mac",
  platform: "darwin-arm64",
  backend: "apple",
  version: "0.0.5",
  status: "online",
  lastSeenAt: "2026-09-08T00:00:00.000Z",
  logins: ["codex", "claude"],
  capacity: { available: 2 },
  imageDigest: "sha256:abc",
  ownerUserId: "user_a",
} as const;

describe("runner API", () => {
  test("lists the exact A runner projection and drops malformed rows", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const rows = await fetchRunners(async (path, init) => {
      calls.push([path, init]);
      return Response.json([runner, { id: "bad" }]);
    });
    expect(calls).toEqual([["/api/runners", { cache: "no-store" }]]);
    expect(rows).toEqual([
      {
        id: "rn_a",
        name: "Desk Mac",
        platform: "darwin-arm64",
        backend: "apple",
        version: "0.0.5",
        status: "online",
        lastSeenAt: "2026-09-08T00:00:00.000Z",
        logins: ["codex", "claude"],
        imageDigest: "sha256:abc",
        ownerUserId: "user_a",
      },
    ]);
  });

  test("enrols with the frozen body and never puts the token in the URL", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const result = await enrolRunner(
      { name: "This Mac", platform: "darwin-arm64" },
      async (path, init) => {
        calls.push([path, init]);
        return Response.json({ runnerId: "rn_new", token: "secret-once" }, { status: 201 });
      },
    );
    expect(result).toEqual({ runnerId: "rn_new", token: "secret-once" });
    expect(calls[0]?.[0]).toBe("/api/runners/enrol");
    expect(calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ name: "This Mac", platform: "darwin-arm64" }),
    });
    expect(calls[0]?.[0]).not.toContain("secret-once");
  });

  test("reads and updates org policy at the frozen endpoint", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetcher = async (path: string, init?: RequestInit) => {
      calls.push([path, init]);
      return Response.json({ allowLocalExecution: true, allowLocalLogins: false });
    };
    expect(await fetchRunnerPolicy(fetcher)).toEqual({
      allowLocalExecution: true,
      allowLocalLogins: false,
    });
    await updateRunnerPolicy({ allowLocalLogins: false }, fetcher);
    expect(calls).toEqual([
      ["/api/runners/policy", { cache: "no-store" }],
      [
        "/api/runners/policy",
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ allowLocalLogins: false }),
        },
      ],
    ]);
  });

  test("reads the deployment runner kill switch from config", async () => {
    expect(
      await fetchRunnerEnabled(async () => Response.json({ runner: { enabled: true } })),
    ).toBe(true);
  });

  test("revokes only the encoded runner resource", async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    await revokeRunner("rn/a", async (path, init) => {
      calls.push([path, init]);
      return Response.json({ id: "rn/a", status: "revoked" });
    });
    expect(calls).toEqual([["/api/runners/rn%2Fa", { method: "DELETE" }]]);
  });

  test("checks the Better Auth active organization membership for an admin", async () => {
    const calls: string[] = [];
    const allowed = await canManageRunnerPolicy("org_active", async (path) => {
      calls.push(path);
      return Response.json({ role: "admin" });
    });
    expect(allowed).toBe(true);
    expect(calls).toEqual([
      "/api/auth/organization/get-active-member-role?organizationId=org_active",
    ]);
  });
});
