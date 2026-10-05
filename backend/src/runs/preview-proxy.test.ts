import { describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { runs } from "../db/schema";
import { forgetLiveThreadSandbox, rememberLiveThreadSandbox } from "../engines/sandbox-runtime";
import * as sandboxProviders from "../sandboxes/provider";
import { getThreadExpectedSandbox, sandboxBindingExpectation, ExpectedSandboxMismatchError } from "../sandboxes/binding";
import { buildForwardHeaders, buildProxyResponse, invalidatePreviewEndpoint, resolvePreviewEndpoint, resolvePreviewSandbox } from "./preview-proxy";

test("a fenced live turn bypasses root-run handle and endpoint caches before any remote work", async () => {
  const threadId = crypto.randomUUID();
  const orgId = `preview-fence-${threadId}`;
  const calls: string[] = [];
  const stale = { id: "stale", getPreviewLink: async () => ({ url: "https://stale.invalid" }),
    start: async () => { calls.push("stale:start"); } } as unknown as sandboxProviders.SandboxHandle;
  const sandbox = { id: "expected", state: "stopped", start: async () => { calls.push("expected:start"); },
    getPreviewLink: async () => { calls.push("expected:preview"); return { url: "https://expected.invalid" }; } } as unknown as sandboxProviders.SandboxHandle;
  const provider = { connectionFingerprint: "a".repeat(64), get: async () => { calls.push("get"); return sandbox; } } as unknown as sandboxProviders.SandboxProvider;
  const expected = sandboxBindingExpectation({ kind: "cube", credential: "env", userId: null,
    snapshot: null, provider }, orgId, sandbox.id);
  const factory = spyOn(sandboxProviders, "sandboxProviderFor").mockReturnValue(provider);
  try {
    rememberLiveThreadSandbox(threadId, stale);
    expect((await resolvePreviewEndpoint(threadId, 6080)).sandboxId).toBe("stale");
    const base = { orgId, threadId, prompt: "fixture", model: "mock", engine: "mock" as const,
      sandboxId: sandbox.id, sandboxProvider: "cube" as const, sandboxCredential: "env" as const };
    await db.insert(runs).values([
      { ...base, id: threadId, status: "completed", createdAt: new Date(1) },
      { ...base, id: crypto.randomUUID(), parentRunId: threadId, status: "running", expectedSandbox: expected, createdAt: new Date(2) },
    ]);
    const active = await getThreadExpectedSandbox(orgId, threadId);
    expect((await resolvePreviewSandbox(threadId, active)).id).toBe("expected");
    expect((await resolvePreviewEndpoint(threadId, 6080, false, active)).sandboxId).toBe("expected");
    expect(calls).toEqual(["get", "expected:start", "get", "expected:start", "expected:preview"]);
    calls.length = 0;
    factory.mockReturnValue({ ...provider, connectionFingerprint: "b".repeat(64) });
    await expect(resolvePreviewSandbox(threadId, active)).rejects.toBeInstanceOf(ExpectedSandboxMismatchError);
    await expect(resolvePreviewEndpoint(threadId, 6080, false, active)).rejects.toBeInstanceOf(ExpectedSandboxMismatchError);
    expect(calls).toEqual([]);
  } finally {
    factory.mockRestore();
    forgetLiveThreadSandbox(threadId);
    invalidatePreviewEndpoint(threadId, 6080);
    await db.delete(runs).where(eq(runs.orgId, orgId));
  }
});

describe("preview proxy forward headers", () => {
  test("the endpoint's auth headers replace anything the browser sent; hop-by-hop and inbound credentials are dropped", () => {
    const inbound = new Headers({
      host: "app.example",
      connection: "keep-alive",
      cookie: "__Secure-better-auth.session_token=browser-session",
      authorization: "Bearer product-api-key",
      "proxy-authorization": "Basic product-proxy-credential",
      forwarded: "for=192.0.2.1;host=app.example;proto=https",
      "x-forwarded": "for=192.0.2.1",
      "x-forwarded-for": "192.0.2.1",
      "x-forwarded-host": "app.example",
      "x-forwarded-proto": "https",
      "x-forwarded-custom-auth": "product-credential",
      "x-real-ip": "192.0.2.1",
      "x-daytona-preview-token": "leaked",
      "cube-traffic-access-token": "leaked",
      accept: "text/event-stream",
      "x-preview-app": "preserved",
    });
    const box = buildForwardHeaders(inbound, { cookie: "_port_auth=port-cookie" });
    expect(box.get("cookie")).toBe("_port_auth=port-cookie");
    expect(box.get("x-daytona-preview-token")).toBeNull();
    expect(box.get("cube-traffic-access-token")).toBeNull();
    expect(box.get("host")).toBeNull();
    for (const name of ["authorization", "proxy-authorization", "forwarded", "x-forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-custom-auth", "x-real-ip"]) {
      expect(box.get(name)).toBeNull();
    }
    expect(box.get("accept")).toBe("text/event-stream");
    expect(box.get("x-preview-app")).toBe("preserved");

    const daytona = buildForwardHeaders(inbound, { "x-daytona-preview-token": "real" });
    expect(daytona.get("x-daytona-preview-token")).toBe("real");
    expect(daytona.get("cookie")).toBeNull();
    expect(buildForwardHeaders(inbound, { authorization: "Bearer provider-only" }).get("authorization")).toBe("Bearer provider-only");
  });

  test("a sandbox response cannot set product cookies, clear product storage, or widen service-worker scope", async () => {
    const response = buildProxyResponse(new Response("data: preview\n\n", {
      headers: {
        "content-type": "text/event-stream",
        "set-cookie": "product-session=attacker; Path=/; Secure",
        "set-cookie2": "product-session=attacker; Path=/; Secure",
        "clear-site-data": '"cookies", "storage"',
        "service-worker-allowed": "/",
        "x-preview-app": "preserved",
      },
    }));
    for (const name of ["set-cookie", "set-cookie2", "clear-site-data", "service-worker-allowed"]) {
      expect(response.headers.get(name)).toBeNull();
    }
    expect(response.headers.get("x-preview-app")).toBe("preserved");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(await response.text()).toBe("data: preview\n\n");
  });
});
