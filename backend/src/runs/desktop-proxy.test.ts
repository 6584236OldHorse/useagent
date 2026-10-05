import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { runs } from "../db/schema";
import * as desktop from "../engines/desktop";
import { forgetLiveThreadSandbox, rememberLiveThreadSandbox } from "../engines/sandbox-runtime";
import * as sandboxProviders from "../sandboxes/provider";
import { sandboxBindingExpectation } from "../sandboxes/binding";
import { invalidatePreviewEndpoint, resolvePreviewEndpoint } from "./preview-proxy";
import { betterAuthTrustedOrigins } from "../env";
import type { AppEnv } from "../http";
import { requireBrowserWebSocketOrigin } from "../security/browser-websocket-origin";
import { withoutClientControlBar, desktopClientQueryRedirect, desktopProxyRoutes } from "./desktop-proxy";
import { terminalRoutes } from "./terminal";
import { portProxyRoutes } from "./port-proxy";

describe("browser WebSocket origin policy", () => {
  // The documented frontend command runs on :3400 without configuration.
  // Do not derive this fallback from the backend value being checked.
  const frontendOrigin = new URL(process.env.FRONTEND_ORIGIN ?? "http://localhost:3400").origin;
  const paths = [
    "/api/runs/origin-test-run/terminal",
    "/api/desktop-proxy/origin-test-thread/websockify",
  ];

  function fixture() {
    const app = new Hono<AppEnv>();
    // Resolve only the auth context; exercise the actual production route and
    // Hono/Bun upgrade adapter without invoking provider callbacks or a DB.
    app.use("*", async (c, next) => {
      c.set("orgId", "origin-test-org");
      c.set("userId", "origin-test-user");
      return next();
    });
    app.route("/api/runs", terminalRoutes);
    app.route("/api/desktop-proxy", desktopProxyRoutes);
    let upgrades = 0;
    const server = {
      requestIP: () => ({ address: "127.0.0.1" }),
      upgrade: () => { upgrades++; return true; },
    };
    return { app, server, upgrades: () => upgrades };
  }

  test("default auth origins match the documented frontend port", () => {
    expect(betterAuthTrustedOrigins({})).toContain("http://localhost:3400");
    expect(betterAuthTrustedOrigins({})).not.toContain("http://localhost:3200");
  });

  test("both browser routes reject untrusted origins before upgrading", async () => {
    const { app, server, upgrades } = fixture();
    const expected = frontendOrigin;
    const wrongPort = new URL(expected);
    wrongPort.port = wrongPort.port === "8443" ? "8444" : "8443";
    for (const path of paths) {
      for (const origin of [undefined, "null", "https://untrusted.example", wrongPort.origin, `${expected}/`]) {
        const headers = new Headers({ upgrade: "websocket" });
        if (origin !== undefined) headers.set("origin", origin);
        const response = await app.request(path, { headers }, server);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: "forbidden_origin" });
      }
    }
    expect(upgrades()).toBe(0);
  });

  test("both browser routes permit the exact configured frontend origin", async () => {
    const { app, server, upgrades } = fixture();
    for (const path of paths) {
      const response = await app.request(path, {
        headers: { upgrade: "WebSocket", origin: frontendOrigin },
      }, server);
      // The real adapter returns an empty response when Bun accepts an upgrade.
      expect(response.status).toBe(200);
    }
    expect(upgrades()).toBe(2);
  });

  test("ordinary HTTP does not acquire a WebSocket Origin requirement", async () => {
    const app = new Hono<AppEnv>();
    app.get("/http", requireBrowserWebSocketOrigin, (c) => c.text("ordinary HTTP"));
    const response = await app.request("/http");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ordinary HTTP");
  });

  test("the configured origin still completes a native Bun socket upgrade", async () => {
    const { app } = fixture();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: app.fetch,
      // Do not dispatch provider callbacks: this test proves only the real
      // HTTP/WebSocket upgrade boundary, with no DB or sandbox operations.
      websocket: {
        open(socket) { socket.send("upgraded"); socket.close(); },
        message() {},
      },
    });
    try {
      for (const path of paths) {
        const result = await new Promise<string>((resolve, reject) => {
          const socket = new WebSocket(`${server.url.origin.replace("http:", "ws:")}${path}`, {
            headers: { origin: frontendOrigin },
          });
          const timeout = setTimeout(() => { socket.close(); reject(new Error("upgrade timed out")); }, 2_000);
          socket.onmessage = (event) => { clearTimeout(timeout); resolve(String(event.data)); };
          socket.onerror = () => { clearTimeout(timeout); reject(new Error("upgrade failed")); };
        });
        expect(result).toBe("upgraded");
      }
    } finally {
      server.stop(true);
    }
  });
});

describe("desktop proxy recovery", () => {
  test("reflects provider VNC client state without replacing the proxy path", () => {
    const source = new URL(
      "https://app.example/api/desktop-proxy/thread/vnc.html?autoconnect=1&path=api%2Fdesktop-proxy%2Fthread%2Fwebsockify",
    );
    const redirect = desktopClientQueryRedirect(source, {
      password: "provider-password",
    });
    expect(redirect).not.toBeNull();
    expect(redirect).toStartWith("/api/desktop-proxy/");
    const parsed = new URL(redirect!, source.origin);
    expect(parsed.searchParams.get("password")).toBe("provider-password");
    expect(parsed.searchParams.get("path")).toBe(
      "api/desktop-proxy/thread/websockify",
    );
    expect(
      desktopClientQueryRedirect(parsed, { password: "provider-password" }),
    ).toBeNull();
  });

  test("root-run desktop and terminal routes enforce a live child's binding even with warm caches", async () => {
    const threadId = crypto.randomUUID();
    const orgId = `desktop-fence-${threadId}`;
    const calls: string[] = [];
    const stale = { id: "stale", getPreviewLink: async () => ({ url: "https://stale.invalid" }),
      process: { createPty: async () => { calls.push("pty"); throw new Error("fixture PTY"); } } } as unknown as sandboxProviders.SandboxHandle;
    const provider = { connectionFingerprint: "a".repeat(64),
      get: async () => { calls.push("get"); return stale; } } as unknown as sandboxProviders.SandboxProvider;
    const expected = sandboxBindingExpectation({ kind: "cube", credential: "env", userId: null,
      snapshot: null, provider, logins: [] }, orgId, "expected");
    const factory = spyOn(sandboxProviders, "sandboxProviderFor").mockReturnValue({ ...provider, connectionFingerprint: "b".repeat(64) });
    const repair = spyOn(desktop, "ensureSandboxDesktopView").mockImplementation(async () => {
      calls.push("repair");
      return { available: true, browserTools: false, home: "/home/fixture", workdir: "/home/fixture/work", browserExecutable: null };
    });
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { c.set("orgId", orgId); c.set("userId", "fixture-user"); return next(); });
    app.route("/api/runs", terminalRoutes);
    app.route("/api/desktop-proxy", desktopProxyRoutes);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch, websocket });
    app.route("/api/port-proxy", portProxyRoutes);
    try {
      const base = { orgId, threadId, prompt: "fixture", model: "mock", engine: "mock" as const,
        sandboxId: "expected", sandboxProvider: "cube" as const, sandboxCredential: "env" as const };
      await db.insert(runs).values({ ...base, id: threadId, status: "completed", createdAt: new Date(1) });
      rememberLiveThreadSandbox(threadId, stale);
      expect((await app.request(`/api/desktop-proxy/${threadId}/ready`)).status).toBe(204);
      await resolvePreviewEndpoint(threadId, 6080);
      calls.length = 0;
      await db.insert(runs).values({ ...base, id: crypto.randomUUID(), parentRunId: threadId,
        status: "running", expectedSandbox: expected, createdAt: new Date(2) });
      for (const path of ["ready", "vnc.html"]) {
        const response = await app.request(`/api/desktop-proxy/${threadId}/${path}`);
        expect(response.status).toBe(502);
        expect(await response.text()).toContain("accepted sandbox binding");
      }
      const portResponse = await app.request(`/api/port-proxy/${threadId}/6080/`);
      expect(portResponse.status).toBe(502);
      expect(await portResponse.text()).toContain("accepted sandbox binding");
      const origin = new URL(process.env.FRONTEND_ORIGIN ?? "http://localhost:3400").origin;
      for (const path of [`/api/runs/${threadId}/terminal`, `/api/desktop-proxy/${threadId}/websockify`]) {
        await new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(`${server.url.origin.replace("http:", "ws:")}${path}`, { headers: { origin } });
          const timeout = setTimeout(() => { socket.close(); reject(new Error("fenced socket did not close")); }, 2_000);
          socket.onclose = () => { clearTimeout(timeout); resolve(); };
          socket.onerror = () => { clearTimeout(timeout); reject(new Error("socket upgrade failed")); };
        });
      }
      expect(calls).toEqual([]);
    } finally {
      server.stop(true);
      repair.mockRestore();
      factory.mockRestore();
      forgetLiveThreadSandbox(threadId);
      invalidatePreviewEndpoint(threadId, 6080);
      await db.delete(runs).where(eq(runs.orgId, orgId));
    }
  });
});

describe("served desktop client page", () => {
  test("hides the floating control bar and leaves other markup alone", () => {
    const page = "<html><head><title>x</title></head><body><div id=\"noVNC_control_bar_anchor\"></div></body></html>";
    const served = withoutClientControlBar(page);
    expect(served).toContain("#noVNC_control_bar_anchor{display:none!important}</style></head>");
    expect(served.replace(/<style>.*?<\/style>/, "")).toBe(page);
    expect(withoutClientControlBar("not html")).toBe("not html");
  });
});
