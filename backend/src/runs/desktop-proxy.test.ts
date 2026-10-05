import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { runs } from "../db/schema";
import * as desktop from "../engines/desktop";
import { forgetLiveThreadSandbox, rememberLiveThreadSandbox } from "../engines/sandbox-runtime";
import * as sandboxProviders from "../sandboxes/provider";
import { sandboxBindingExpectation } from "../sandboxes/binding";
import { invalidatePreviewEndpoint, PREVIEW_SANDBOX_POLICY, resolvePreviewEndpoint } from "./preview-proxy";
import { previewViewPrefix } from "./preview-capability";
import { betterAuthTrustedOrigins } from "../env";
import type { AppEnv } from "../http";
import { requireBrowserWebSocketOrigin } from "../security/browser-websocket-origin";
import { browserExtensionFault, withFrameBridge, withoutClientControlBar, desktopClientQueryRedirect, desktopProxyRoutes } from "./desktop-proxy";
import { terminalRoutes } from "./terminal";
import { portProxyRoutes } from "./port-proxy";

describe("browser WebSocket origin policy", () => {
  // The documented frontend command runs on :3400 without configuration.
  // Do not derive this fallback from the backend value being checked.
  const frontendOrigin = new URL(process.env.FRONTEND_ORIGIN ?? "http://localhost:3400").origin;
  const paths = ["/api/runs/origin-test-run/terminal"];

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
    expect(upgrades()).toBe(1);
  });

  test("the desktop socket upgrades only on a valid capability, never on the session", async () => {
    const { app, server, upgrades } = fixture();
    const grant = { orgId: "origin-test-org", userId: "origin-test-user", threadId: "origin-test-thread", port: 6080 };
    const view = previewViewPrefix("/api/desktop-proxy", { ...grant, kind: "desktop" });
    const refused = [
      // The pre-capability session socket no longer exists.
      "/api/desktop-proxy/origin-test-thread/view/not-a-capability/websockify",
      `${previewViewPrefix("/api/desktop-proxy", { ...grant, kind: "port" })}/websockify`,
      `${previewViewPrefix("/api/desktop-proxy", { ...grant, threadId: "other", kind: "desktop" }).replace("/other/", "/origin-test-thread/")}/websockify`,
    ];
    for (const path of refused) {
      const response = await app.request(path, { headers: { upgrade: "websocket", origin: "null", cookie: "s=1" } }, server);
      expect(response.status).toBe(401);
    }
    // The sandboxed page's socket carries `Origin: null` and no session.
    const accepted = await app.request(`${view}/websockify`, { headers: { upgrade: "websocket", origin: "null" } }, server);
    expect(accepted.status).toBe(200);
    expect(upgrades()).toBe(1);
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    try {
      const expired = await app.request(`${view}/websockify`, { headers: { upgrade: "websocket", origin: "null" } }, server);
      expect(expired.status).toBe(401);
    } finally {
      setSystemTime();
    }
    expect(upgrades()).toBe(1);
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
    app.use("*", async (c, next) => { if (!c.get("orgId")) { c.set("orgId", orgId); c.set("userId", "fixture-user"); } return next(); });
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
      const portEntry = await app.request(`/api/port-proxy/${threadId}/6080/`);
      const portResponse = await app.request(portEntry.headers.get("location") ?? "");
      expect(portResponse.status).toBe(502);
      expect(await portResponse.text()).toContain("accepted sandbox binding");
      const origin = new URL(process.env.FRONTEND_ORIGIN ?? "http://localhost:3400").origin;
      const desktopView = previewViewPrefix("/api/desktop-proxy", {
        orgId, userId: "fixture-user", threadId, port: 6080, kind: "desktop",
      });
      for (const path of [`/api/runs/${threadId}/terminal`, `${desktopView}/websockify`]) {
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

describe("desktop session entry", () => {
  test("hands the pane a sandboxed view whose socket path both noVNC generations resolve", async () => {
    const threadId = crypto.randomUUID();
    const orgId = `desktop-view-${threadId}`;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => new URL(request.url).pathname === "/vnc.html"
        ? new Response("<html><head><title>noVNC</title></head><body></body></html>", { headers: { "content-type": "text/html" } })
        : new Response("not found", { status: 404 }),
    });
    const sandbox = { id: "view-box", getPreviewLink: async () => ({ url: upstream.url.origin }) } as unknown as sandboxProviders.SandboxHandle;
    const repair = spyOn(desktop, "ensureSandboxDesktopView").mockResolvedValue({
      available: true, browserTools: false, home: "/home/fixture", workdir: "/home/fixture/work", browserExecutable: null,
    });
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => { if (!c.get("orgId")) { c.set("orgId", orgId); c.set("userId", "member"); } return next(); });
    app.route("/api/desktop-proxy", desktopProxyRoutes);
    try {
      await db.insert(runs).values({ id: threadId, orgId, threadId, prompt: "fixture", model: "mock", engine: "mock", status: "completed" });
      rememberLiveThreadSandbox(threadId, sandbox);
      const entry = await app.request(`/api/desktop-proxy/${threadId}/vnc.html?autoconnect=true&path=stale`);
      expect(entry.status).toBe(307);
      const location = new URL(entry.headers.get("location") ?? "", "https://app.example");
      const view = location.pathname.replace(/\/vnc\.html$/, "");
      expect(view).toStartWith(`/api/desktop-proxy/${threadId}/view/v1.`);
      expect(location.searchParams.get("autoconnect")).toBe("true");
      const path = location.searchParams.get("path") ?? "";
      expect(new URL(path, location).pathname).toBe(`${view}/websockify`);
      expect(new URL(`wss://app.example/${path}`).pathname).toBe(`${view}/websockify`);

      const page = await app.request(`${location.pathname}${location.search}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-security-policy")).toBe(PREVIEW_SANDBOX_POLICY);
      const html = await page.text();
      expect(html).toStartWith("<html><head><script>");
      expect(html).toContain("desktopConnected");
      expect(html).toContain("#noVNC_control_bar_anchor{display:none!important}");
      // Another thread's id in the path does not borrow this view.
      const foreign = await app.request(location.pathname.replace(threadId, crypto.randomUUID()));
      expect(foreign.status).toBe(401);
    } finally {
      upstream.stop(true);
      repair.mockRestore();
      forgetLiveThreadSandbox(threadId);
      invalidatePreviewEndpoint(threadId, 6080);
      await db.delete(runs).where(eq(runs.orgId, orgId));
    }
  });
});

describe("served desktop client page", () => {
  test("runs the frame bridge before any noVNC script", () => {
    const page = "<html><head lang=\"en\"><script src=\"app/ui.js\"></script></head><body></body></html>";
    const served = withFrameBridge(page);
    expect(served.indexOf("desktopConnected")).toBeLessThan(served.indexOf("app/ui.js"));
    expect(served.replace(/<script>[\s\S]*?<\/script>/, "")).toBe(page);
    expect(withFrameBridge("not html")).toBe("not html");
  });

  test("keeps browser extension errors out of noVNC's error panel", () => {
    const metamask = "i: Failed to connect to MetaMask\n    at Object.connect (chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js:7:1)";
    expect(browserExtensionFault(metamask)).toBe(true);
    expect(browserExtensionFault(undefined, "moz-extension://abc/content.js")).toBe(true);
    expect(browserExtensionFault("Error: closed\n    at RFB._fail (http://127.0.0.1:6080/core/rfb.js:9:1)", "http://127.0.0.1:6080/core/rfb.js")).toBe(false);
    expect(browserExtensionFault(undefined)).toBe(false);
    const script = withFrameBridge("<html><head></head></html>").match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('addEventListener("unhandledrejection"');
  });

  test("hides the floating control bar and leaves other markup alone", () => {
    const page = "<html><head><title>x</title></head><body><div id=\"noVNC_control_bar_anchor\"></div></body></html>";
    const served = withoutClientControlBar(page);
    expect(served).toContain("#noVNC_control_bar_anchor{display:none!important}</style></head>");
    expect(served.replace(/<style>.*?<\/style>/, "")).toBe(page);
    expect(withoutClientControlBar("not html")).toBe("not html");
  });
});
