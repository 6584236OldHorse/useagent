import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { runIntentFingerprint } from "../src/commands/fingerprint";
import type { RunCommandIntent } from "../src/commands/types";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { acceptRunCommand } from "../src/commands";
import { MACHINE_NOT_CONNECTED_REASON, machineUnavailable, runLocationChoice } from "../src/runs/run-location";
import { createOrgSession, json, uid } from "./helpers";

// Where a thread runs is a choice made on its root run: absent is the cloud (the
// control plane never places a run on a machine nobody chose), "local" needs the
// machine connected and allowed at the moment of the choice, and every reply
// carries its thread's location so the worker reads its own row.

const scope = { orgId: "org", userId: "user" };
const allow = async () => ({ allowLocalExecution: true });

describe("run location choice", () => {
  test("absent is the cloud, a reply carries no choice of its own, and an unknown value names the targets", () => {
    expect(runLocationChoice(undefined, false)).toEqual({ ok: true, runLocation: null });
    expect(runLocationChoice(null, false)).toEqual({ ok: true, runLocation: null });
    expect(runLocationChoice("cloud", false)).toEqual({ ok: true, runLocation: "cloud" });
    expect(runLocationChoice("local", false)).toEqual({ ok: true, runLocation: "local" });
    expect(runLocationChoice("local", true)).toEqual({ ok: true, runLocation: undefined });
    expect(runLocationChoice("laptop", false)).toEqual({
      ok: false,
      status: 400,
      body: { error: "run_location must be one of: cloud, local" },
    });
  });

  test("the machine takes the work only when the deployment and the organisation allow it and it is connected", async () => {
    const deps = { env: {}, policy: allow, machineOnline: () => true };
    expect(await machineUnavailable(scope, deps)).toBeNull();
    expect(await machineUnavailable(scope, { ...deps, machineOnline: () => false })).toEqual({
      status: 409,
      body: { error: "machine_not_connected", reason: MACHINE_NOT_CONNECTED_REASON },
    });
    expect(await machineUnavailable({ ...scope, userId: null }, deps)).toMatchObject({
      status: 409,
      body: { error: "machine_not_connected" },
    });
    expect(await machineUnavailable(scope, { ...deps, policy: async () => ({ allowLocalExecution: false }) })).toEqual({
      status: 409,
      body: {
        error: "local_execution_disabled",
        reason: "Local execution is switched off for this organisation, so this can only run on the cloud.",
      },
    });
    expect(await machineUnavailable(scope, { ...deps, env: { LOCAL_RUNNERS: "off" } })).toEqual({
      status: 409,
      body: {
        error: "local_execution_disabled",
        reason: "Local execution is switched off for this deployment, so this can only run on the cloud.",
      },
    });
  });

  test("the choice joins the intent fingerprint only when made, so earlier submissions keep theirs", () => {
    const base: RunCommandIntent = {
      prompt: "p", model: null, engine: null, parentRunId: null, requestedRepos: [], requestedResources: [],
      attachmentIds: [], memoryScope: "org", skillId: null, skillVersion: null, commandName: null,
      commandProvider: null, commandSessionId: null, commandCatalogRevision: null,
    };
    expect(runIntentFingerprint({ ...base, runLocation: null })).toBe(runIntentFingerprint(base));
    expect(runIntentFingerprint({ ...base, runLocation: "local" })).not.toBe(runIntentFingerprint(base));
    expect(runIntentFingerprint({ ...base, runLocation: "local" })).not.toBe(runIntentFingerprint({ ...base, runLocation: "cloud" }));
  });
});

describe("POST /api/runs run_location", () => {
  test("an unknown target is refused with the offered ones, and a machine that is not connected with a plain message", async () => {
    const { cookies } = await createOrgSession("run-location");
    const unknown = await json<{ error: string }>("/api/runs", {
      method: "POST", cookies, body: { prompt: "x", engine: "mock", run_location: "laptop" },
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe("run_location must be one of: cloud, local");
    // No machine is enrolled in the test process, so the person's machine is not connected.
    const away = await json<{ error: string; reason: string }>("/api/runs", {
      method: "POST", cookies, body: { prompt: "x", engine: "mock", run_location: "local" },
    });
    expect(away.status).toBe(409);
    expect(away.body).toEqual({ error: "machine_not_connected", reason: MACHINE_NOT_CONNECTED_REASON });
  });

  test("the choice is recorded on the root run, absent means none, every reply copies its thread's, and the API reports it", async () => {
    const { cookies } = await createOrgSession("run-location-thread");
    const root = await json<{ id: string }>("/api/runs", {
      method: "POST", cookies, body: { prompt: "Cloud work.", engine: "mock", run_location: "cloud" },
    });
    expect(root.status).toBe(201);
    // A reply's own value is ignored: "local" would be refused on a root run here, yet the reply is accepted on the thread's cloud.
    const reply = await json<{ id: string }>("/api/runs", {
      method: "POST", cookies, body: { prompt: "More.", engine: "mock", parent_run_id: root.body.id, run_location: "local" },
    });
    expect(reply.status).toBe(201);
    const plain = await json<{ id: string }>("/api/runs", { method: "POST", cookies, body: { prompt: "Plain.", engine: "mock" } });
    expect(plain.status).toBe(201);
    const location = async (id: string) =>
      (await db.select({ runLocation: runs.runLocation }).from(runs).where(eq(runs.id, id)))[0]?.runLocation;
    expect(await location(root.body.id)).toBe("cloud");
    expect(await location(reply.body.id)).toBe("cloud");
    expect(await location(plain.body.id)).toBeNull();
    const shown = await json<{ run_location: unknown }>(`/api/runs/${root.body.id}`, { cookies });
    expect(shown.status).toBe(200);
    expect(shown.body.run_location).toBe("cloud");
    const shownPlain = await json<{ run_location: unknown }>(`/api/runs/${plain.body.id}`, { cookies });
    expect(shownPlain.body.run_location).toBeNull();
  });

  test("an accepted local request replays under its key whatever the machine is doing today", async () => {
    // Accepted while the machine was connected (the acceptance itself does not ask); the
    // identical retry arrives with no machine in the process and must still answer the run.
    const { cookies, orgId } = await createOrgSession("run-location-replay");
    const key = uid("run-location-replay");
    const prompt = "Local work, retried.";
    const runId = crypto.randomUUID();
    const intent: RunCommandIntent = {
      prompt, model: null, engine: "mock", parentRunId: null, requestedRepos: [], requestedResources: [],
      attachmentIds: [], memoryScope: null, permissionMode: null, runLocation: "local", skillId: null, skillVersion: null,
      commandName: null, commandProvider: null, commandSessionId: null, commandCatalogRevision: null, expectedSandbox: null,
    };
    expect(await acceptRunCommand({
      idempotencyKey: key, orgId, actorId: null, intent,
      run: {
        id: runId, prompt, model: "claude-opus-5", engine: "mock", parentRunId: null, threadId: runId, repos: [],
        resolvedResources: [], memoryScope: "org", runLocation: "local", skillId: null, skillVersion: null,
        skillContentHash: null, commandName: null, commandProvider: null, commandSessionId: null, commandCatalogRevision: null,
      },
    })).toMatchObject({ status: "created", runId });
    const replay = await json<{ id: string }>("/api/runs", {
      method: "POST", cookies, headers: { "Idempotency-Key": key }, body: { prompt, engine: "mock", run_location: "local" },
    });
    expect(replay).toMatchObject({ status: 200, body: { id: runId } });
  });
});
