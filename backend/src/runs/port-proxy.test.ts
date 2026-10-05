import { describe, expect, setSystemTime, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../http";
import {
  createPortProxyRoutes,
  parsePreviewPort,
  rewriteProxyLocation,
  type PortProxyDeps,
} from "./port-proxy";
import { portProxyUrl } from "./port-proxy-url";
import { PREVIEW_SANDBOX_POLICY, type PreviewEndpoint } from "./preview-proxy";
import { previewViewPrefix } from "./preview-capability";

interface Upstream {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: string | null;
}

function harness(overrides: Partial<PortProxyDeps> & {
  readonly answer?: (call: Upstream, attempt: number) => Response;
} = {}) {
  const calls: Upstream[] = [];
  const resolves: { threadId: string; port: number; force: boolean }[] = [];
  const endpoint = (port: number): PreviewEndpoint => ({
    sandboxId: "box-1",
    baseUrl: `http://box-1.preview.internal:${port}`,
    token: "preview-token",
    headers: { "x-daytona-preview-token": "preview-token" },
    resolvedAt: Date.now(),
  });
  const deps: PortProxyDeps = {
    threadBinding: async (orgId, threadId) => orgId === "org-a" && threadId === "thread-1" ? { expectedSandbox: null } : null,
    resolveEndpoint: async (threadId, port, force = false) => {
      resolves.push({ threadId, port, force });
      return endpoint(port);
    },
    invalidateEndpoint: () => {},
    fetch: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input.toString(), init);
      const call = {
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? null : await request.text(),
      };
      calls.push(call);
      return (overrides.answer ?? (() => new Response("<h1>served</h1>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })))(call, calls.length);
    }) as typeof fetch,
    ...overrides,
  };
  const app = new Hono<AppEnv>();
  app.route("/api/port-proxy", createPortProxyRoutes(deps, async (c, next) => {
    // Stands in for the session (orgScope is a no-op once a capability resolved the org).
    if (!c.get("orgId")) {
      c.set("orgId", "org-a");
      c.set("userId", "user-a");
    }
    await next();
  }));
  // A browser follows the session entry's redirect into the capability view.
  const open = async (path: string, init?: RequestInit) => {
    const entry = await app.request(path, init);
    expect(entry.status).toBe(307);
    const view = entry.headers.get("location") ?? "";
    expect(view).toMatch(/^\/api\/port-proxy\/thread-1\/view\/v1\.[^/]+/);
    return app.request(view, init);
  };
  return { app, calls, resolves, open };
}

describe("port proxy", () => {
  test("maps the product path onto the served port with the preview credential injected", async () => {
    const { open, calls, resolves } = harness();
    const res = await open("/api/port-proxy/thread-1/8080/assets/app.js?v=2", {
      headers: { cookie: "session=browser", accept: "text/javascript" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<h1>served</h1>");
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(resolves).toEqual([{ threadId: "thread-1", port: 8080, force: false }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://box-1.preview.internal:8080/assets/app.js?v=2");
    expect(calls[0]!.headers.get("x-daytona-preview-token")).toBe("preview-token");
    expect(calls[0]!.headers.get("cookie")).toBeNull();
    expect(calls[0]!.headers.get("accept")).toBe("text/javascript");
  });

  test("the port root and request bodies pass through", async () => {
    const { open, calls } = harness();
    const res = await open("/api/port-proxy/thread-1/3000/", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({
      url: "http://box-1.preview.internal:3000/",
      method: "POST",
      body: '{"hello":"world"}',
    });
  });

  test("a bare thread/port serves the root (the frontend rewrite drops the trailing slash)", async () => {
    const { open, calls } = harness();
    const res = await open("/api/port-proxy/thread-1/8080?tab=1");
    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe("http://box-1.preview.internal:8080/?tab=1");
  });

  test("a thread outside the org and a bad port never reach the sandbox", async () => {
    const { app, calls } = harness();
    expect((await app.request("/api/port-proxy/thread-other/8080/")).status).toBe(404);
    expect((await app.request("/api/port-proxy/thread-1/80800/")).status).toBe(400);
    expect((await app.request("/api/port-proxy/thread-1/0/")).status).toBe(400);
    expect((await app.request("/api/port-proxy/thread-1/http/")).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("a thread with no sandbox yet says so", async () => {
    const { open } = harness({
      resolveEndpoint: async () => { throw new Error("no-sandbox"); },
    });
    const res = await open("/api/port-proxy/thread-1/8080/");
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "no live sandbox for this conversation yet - send a message first",
    });
  });

  test("a stale link is re-resolved once, and a dead port is reported by number", async () => {
    const expectedSandbox = { version: 1 as const, sandboxId: "box-1", provider: "box" as const,
      credential: "env" as const, ownerOrgId: "org-a", ownerUserId: null, credentialGeneration: "a".repeat(64) };
    const bindings: unknown[] = [];
    const { open, calls, resolves } = harness({
      threadBinding: async () => ({ expectedSandbox }),
      resolveEndpoint: async (threadId, port, force = false, binding) => {
        bindings.push(binding);
        resolves.push({ threadId, port, force });
        return { sandboxId: "box-1", baseUrl: "https://fixture.invalid", token: "", headers: {}, resolvedAt: Date.now() };
      },
      answer: () => new Response("bad gateway", { status: 502 }),
    });
    const res = await open("/api/port-proxy/thread-1/8080/");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "nothing is listening on port 8080 in this conversation's sandbox",
    });
    expect(calls).toHaveLength(2);
    expect(resolves.map((r) => r.force)).toEqual([false, true]);
    expect(bindings).toEqual([expectedSandbox, expectedSandbox]);
  });

  test("an app's absolute redirect stays inside the bridge", async () => {
    const { app } = harness({
      answer: () => new Response(null, { status: 302, headers: { location: "/login?next=%2F" } }),
    });
    const entry = await app.request("/api/port-proxy/thread-1/8080/admin");
    const view = new URL(entry.headers.get("location") ?? "", "http://localhost").pathname.replace(/\/admin$/, "");
    const res = await app.request(`${view}/admin`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${view}/login?next=%2F`);
  });

  test("served bytes run sandboxed: opaque origin, no sniffing, CORS for the page's own modules", async () => {
    const { open } = harness({
      answer: () => new Response("<script>fetch('/api/api-keys')</script>", {
        headers: {
          "content-type": "text/html",
          "content-security-policy": "sandbox allow-scripts allow-same-origin",
        },
      }),
    });
    const res = await open("/api/port-proxy/thread-1/8080/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(PREVIEW_SANDBOX_POLICY);
    expect(PREVIEW_SANDBOX_POLICY).not.toContain("allow-same-origin");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("the view refuses a missing, foreign, mismatched or expired capability", async () => {
    const { app, calls } = harness();
    const grant = { orgId: "org-a", userId: "user-a", threadId: "thread-1", port: 8080 };
    const portView = previewViewPrefix("/api/port-proxy", { ...grant, kind: "port" });
    const otherThread = previewViewPrefix("/api/port-proxy", { ...grant, threadId: "thread-2", kind: "port" })
      .replace("/thread-2/", "/thread-1/");
    const desktopKind = previewViewPrefix("/api/port-proxy", { ...grant, kind: "desktop" });
    const tampered = portView.replace(/\.([^.]+)$/, (_, signature: string) => `.${signature.slice(1)}A`);
    for (const view of ["/api/port-proxy/thread-1/view/not-a-capability", otherThread, desktopKind, tampered]) {
      const res = await app.request(`${view}/`, { headers: { cookie: "better-auth.session_token=browser" } });
      expect(res.status).toBe(401);
    }
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    try {
      expect((await app.request(`${portView}/app.js`)).status).toBe(401);
      // A reload re-enters through the session route for a fresh view.
      const reload = await app.request(`${portView}/page?x=1`, { headers: { "sec-fetch-mode": "navigate" } });
      expect(reload.status).toBe(302);
      expect(reload.headers.get("location")).toBe("/api/port-proxy/thread-1/8080/page?x=1");
    } finally {
      setSystemTime();
    }
    expect(calls).toHaveLength(0);
  });

  test("a capability from another org reaches only that org's threads", async () => {
    const { app, calls } = harness();
    const view = previewViewPrefix("/api/port-proxy", {
      orgId: "org-b", userId: "user-b", threadId: "thread-1", port: 8080, kind: "port",
    });
    expect((await app.request(`${view}/`)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("helpers", () => {
    expect(parsePreviewPort("8080")).toBe(8080);
    expect(parsePreviewPort("65536")).toBeNull();
    expect(parsePreviewPort("8a")).toBeNull();
    expect(rewriteProxyLocation("https://elsewhere.example/x", "/api/port-proxy/t/1")).toBeNull();
    expect(rewriteProxyLocation("/api/port-proxy/t/1/already", "/api/port-proxy/t/1")).toBeNull();
    expect(portProxyUrl("http://localhost:3434/", "thread-1", 8080))
      .toBe("http://localhost:3434/api/port-proxy/thread-1/8080/");
  });
});
