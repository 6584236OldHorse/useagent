import { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { getRunForOrg } from "./repo";
import { previewCapabilityScope, previewViewPrefix } from "./preview-capability";
import {
  buildForwardHeaders,
  buildProxyResponse,
  invalidatePreviewEndpoint,
  resolvePreviewEndpoint,
  resolvePreviewSandbox,
  type PreviewEndpoint,
  isStalePreviewResponse,
} from "./preview-proxy";
import { ensureSandboxDesktopView } from "../engines/desktop";
import { sandboxPreviewHeaders } from "../sandboxes/provider";
import { errorMessage } from "../util/error-message";
import { getThreadExpectedSandbox } from "../sandboxes/binding";
import { watchThreadSandbox } from "../engines/sandbox-runtime";
import type { ExpectedSandboxBinding } from "../sandboxes/expected-binding";

// ---------------------------------------------------------------------------
// DESKTOP PROXY — bridge to the noVNC GUI running INSIDE a thread's
// sandbox ("watch the agent's screen"). The useAgent-agent snapshot
// ships Xorg :1 + Budgie + x11vnc :5900 (no password) + noVNC/websockify on :6080.
//
//   browser (iframe) → GET /api/desktop-proxy/<threadId>/vnc.html?…   (session)
//                     → ensure the desktop is up, mint a preview capability and
//                       redirect to /api/desktop-proxy/<threadId>/view/<cap>/vnc.html
//                       with noVNC's socket `path` pointed at the same view.
//                     → HTTP proxy: resolve the thread's :6080 preview endpoint,
//                       inject x-daytona-preview-token, forward noVNC's static
//                       app (html/js/css) under a CSP sandbox (opaque origin,
//                       see preview-capability.ts).
//   noVNC canvas WS   → ws  /api/desktop-proxy/<threadId>/view/<cap>/websockify
//                     → WS bridge (below): open an upstream WS to the sandbox's
//                       websockify with the preview token as a header — browsers
//                       can't set that header, and noVNC rebuilds its socket URL
//                       from window.location (dropping any signed-URL query), so
//                       a tokenised preview URL alone can't authenticate the
//                       socket. The proxy is what makes it work without leaking
//                       the Daytona token to the browser. RFB frames pipe both
//                       ways as binary.
//
// Shares one Bun WebSocket handler (`websocket` from hono/bun, registered in
// index.ts) with the interactive terminal — the same dispatcher routes per
// connection by the events stashed at upgrade.
// ---------------------------------------------------------------------------

const DESKTOP_PORT = 6080;
const DESKTOP_READY_TTL_MS = 30_000;
const desktopRepairs = new Map<string, Promise<void>>();
const desktopReadyUntil = new Map<string, number>();

function invalidateDesktopPreview(threadId: string): void {
  desktopReadyUntil.delete(threadId);
}

/** Reflect provider-issued noVNC client values into the authenticated
 * same-origin iframe URL. Upstream bearer tokens remain server-side headers;
 * only values the browser client itself must read (currently the VNC password)
 * are redirected. */
export function desktopClientQueryRedirect(
  url: URL,
  clientQuery: Readonly<Record<string, string>> | undefined,
): string | null {
  if (!clientQuery) return null;
  const redirected = new URL(url);
  let changed = false;
  for (const [key, value] of Object.entries(clientQuery)) {
    if (redirected.searchParams.get(key) === value) continue;
    redirected.searchParams.set(key, value);
    changed = true;
  }
  return changed ? `${redirected.pathname}${redirected.search}` : null;
}

/** Old retained sandboxes may predate desktop provisioning, and a stopped box
 * may wake without its process session. Repair exactly once per thread while
 * concurrent iframe/static/WebSocket requests wait on the same promise. */
async function ensureDesktopPreview(threadId: string, expectedSandbox?: ExpectedSandboxBinding | null): Promise<void> {
  if (!expectedSandbox) {
    if ((desktopReadyUntil.get(threadId) ?? 0) > Date.now()) return;
    desktopReadyUntil.delete(threadId);
    const existing = desktopRepairs.get(threadId);
    if (existing) return existing;
  }

  const repair = (async () => {
    const sandbox = await resolvePreviewSandbox(threadId, expectedSandbox);
    const desktop = await ensureSandboxDesktopView(sandbox, AbortSignal.timeout(120_000));
    if (!desktop.available) {
      throw new Error(desktop.reason ?? "desktop service unavailable");
    }
    if (!expectedSandbox) desktopReadyUntil.set(threadId, Date.now() + DESKTOP_READY_TTL_MS);
  })().finally(() => { if (!expectedSandbox) desktopRepairs.delete(threadId); });
  if (!expectedSandbox) desktopRepairs.set(threadId, repair);
  return repair;
}

export const desktopProxyRoutes = new Hono<AppEnv>();
desktopProxyRoutes.use("*", previewCapabilityScope);
desktopProxyRoutes.use("*", orgScope);

// ── WebSocket: browser noVNC ⇄ (this bridge) ⇄ sandbox websockify ───────────
// Registered BEFORE the HTTP catch-all so a genuine upgrade is handled here; a
// plain GET to the same path falls through (upgradeWebSocket calls next()).
// The opaque-origin page sends `Origin: null` and no cookie: the capability in
// the path (previewCapabilityScope) is the only authorization.
desktopProxyRoutes.get(
  "/:threadId/view/:capability/websockify",
  upgradeWebSocket((c) => {
    // Capture params NOW — context reads inside async ws callbacks are unreliable.
    const threadId = c.req.param("threadId") ?? "";
    const orgId = c.get("orgId");
    const search = new URL(c.req.url).search;
    let upstream: WebSocket | null = null;
    let closed = false;
    let unwatch = () => {};

    return {
      onOpen: (_evt, ws) => {
        void (async () => {
          try {
            // Org gate: threadId IS its root run's id.
            const run = await getRunForOrg(orgId, threadId);
            if (!run) throw new Error("thread not found");
            const expectedSandbox = run.expectedSandbox ?? await getThreadExpectedSandbox(orgId, threadId);

            await ensureDesktopPreview(threadId, expectedSandbox);
            const ep = await resolvePreviewEndpoint(threadId, DESKTOP_PORT, false, expectedSandbox);
            const wsUrl = `${ep.baseUrl.replace(/^http/, "ws")}/websockify${search}`;
            // Bun's WebSocket client takes custom headers (browsers can't) — this
            // is how the Daytona preview token rides the upstream socket.
            const sock = new WebSocket(wsUrl, {
              headers: { ...ep.headers },
              protocols: ["binary"],
            });
            sock.binaryType = "arraybuffer";
            upstream = sock;
            if (!closed) unwatch = watchThreadSandbox(threadId);
            sock.onmessage = (e) => {
              if (closed) return;
              try {
                ws.send(e.data as ArrayBuffer | string);
              } catch {
                /* browser socket already gone */
              }
            };
            const bye = () => {
              invalidateDesktopPreview(threadId);
              invalidatePreviewEndpoint(threadId, DESKTOP_PORT);
              try {
                ws.close();
              } catch {
                /* already closed */
              }
            };
            sock.onclose = bye;
            sock.onerror = bye;
          } catch {
            // Stale endpoint (sandbox rotated) or no sandbox — drop the cache so
            // the next attempt re-resolves and wakes the box, then close.
            invalidateDesktopPreview(threadId);
            invalidatePreviewEndpoint(threadId, DESKTOP_PORT);
            try {
              ws.close();
            } catch {
              /* already closed */
            }
          }
        })();
      },

      onMessage: (evt) => {
        const sock = upstream;
        if (!sock || sock.readyState !== WebSocket.OPEN) return;
        try {
          // evt.data is a string (text frame) or ArrayBuffer (binary RFB frame).
          sock.send(evt.data as string | ArrayBuffer);
        } catch {
          /* upstream gone */
        }
      },

      onClose: () => {
        closed = true;
        unwatch();
        const sock = upstream;
        upstream = null;
        if (sock) {
          try {
            sock.close();
          } catch {
            /* already closed */
          }
        }
      },
    };
  }),
);

// Lightweight lifecycle probe for the React pane. It performs the one bounded
// repair/readiness check without downloading and discarding vnc.html; the iframe
// that follows reuses the short readiness lease and fetches the HTML exactly once.
desktopProxyRoutes.get("/:threadId/ready", async (c) => {
  const threadId = c.req.param("threadId") ?? "";
  const orgId = c.get("orgId");
  const run = await getRunForOrg(orgId, threadId);
  if (!run) {
    return c.json({ error: "thread not found" }, 404);
  }
  try {
    const expectedSandbox = run.expectedSandbox ?? await getThreadExpectedSandbox(orgId, threadId);
    await ensureDesktopPreview(threadId, expectedSandbox);
    return c.body(null, 204);
  } catch (error) {
    const message = errorMessage(error);
    if (message === "no-sandbox") {
      return c.json(
        { error: "no live sandbox for this conversation yet - send a message first" },
        409,
      );
    }
    return c.json({ error: `desktop proxy failed: ${message}` }, 502);
  }
});

// ── HTTP: noVNC static app (vnc.html + js/css/img) ──────────────────────────
/** The served client page without the floating control bar: the desktop pane is the product's chrome. */
export function withoutClientControlBar(html: string): string {
  const style = "<style>#noVNC_control_bar_anchor{display:none!important}</style>";
  return html.includes("</head>") ? html.replace("</head>", `${style}</head>`) : html;
}

/** Wallets and password managers inject scripts into every page, this one
 *  included. Their failures are not the desktop's, so they stay out of
 *  noVNC's error panel. */
export function browserExtensionFault(stack: unknown, file?: unknown): boolean {
  return /^(?:chrome|moz|safari-web)-extension:/.test(String(file ?? "")) ||
    /(?:chrome|moz|safari-web)-extension:\/\//.test(String(stack ?? ""));
}

/** The sandboxed page cannot use web storage (noVNC keeps its settings there)
 *  and the pane cannot read its document, so this runs first in vnc.html: an
 *  in-memory storage stand-in, a filter that keeps browser extension errors
 *  out of noVNC's error panel, and a message to the embedding pane whenever
 *  noVNC's connected marker changes. */
const FRAME_BRIDGE = `<script>(() => {
const fromExtension = ${browserExtensionFault.toString()};
const dropExtensionFault = (event, stack, file) => {
  if (!fromExtension(stack, file)) return;
  event.stopImmediatePropagation();
  event.preventDefault();
};
addEventListener("error", (event) => dropExtensionFault(event, event.error?.stack, event.filename), true);
addEventListener("unhandledrejection", (event) => dropExtensionFault(event, event.reason?.stack), true);
for (const name of ["localStorage", "sessionStorage"]) {
  try { void window[name].length; } catch {
    const items = new Map();
    Object.defineProperty(window, name, { configurable: true, value: {
      get length() { return items.size; },
      key: (index) => [...items.keys()][index] ?? null,
      getItem: (key) => items.get(String(key)) ?? null,
      setItem: (key, value) => { items.set(String(key), String(value)); },
      removeItem: (key) => { items.delete(String(key)); },
      clear: () => { items.clear(); },
    } });
  }
}
let reported;
new MutationObserver(() => {
  const connected = document.documentElement.classList.contains("noVNC_connected");
  if (connected === reported) return;
  reported = connected;
  parent.postMessage({ desktopConnected: connected }, location.origin);
}).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
})();</script>`;

export function withFrameBridge(html: string): string {
  return html.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${FRAME_BRIDGE}`);
}

async function servedClientPage(upstream: Response): Promise<Response> {
  if (upstream.status !== 200 || !(upstream.headers.get("content-type") ?? "").includes("text/html")) return upstream;
  const headers = new Headers(upstream.headers);
  headers.delete("content-length");
  return new Response(withFrameBridge(withoutClientControlBar(await upstream.text())), { status: upstream.status, headers });
}

desktopProxyRoutes.all("/:threadId/view/:capability/*", async (c) => {
  const threadId = c.req.param("threadId") ?? "";
  const orgId = c.get("orgId");

  const run = await getRunForOrg(orgId, threadId);
  if (!run) {
    return c.json({ error: "thread not found" }, 404);
  }

  const url = new URL(c.req.url);
  const prefix = `/api/desktop-proxy/${threadId}/view/${c.req.param("capability") ?? ""}`;
  const subpath = url.pathname.slice(prefix.length) || "/";
  const expectedSandbox = run.expectedSandbox ?? await getThreadExpectedSandbox(orgId, threadId);

  const method = c.req.method;
  const body =
    method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();

  const forward = async (ep: PreviewEndpoint): Promise<Response> =>
    fetch(`${ep.baseUrl}${subpath}${url.search}`, {
      method,
      headers: buildForwardHeaders(c.req.raw.headers, ep.headers),
      body,
      redirect: "manual",
      signal: c.req.raw.signal,
    });

  try {
    let ep = await resolvePreviewEndpoint(threadId, DESKTOP_PORT, false, expectedSandbox);
    if (subpath === "/vnc.html") {
      const redirect = desktopClientQueryRedirect(url, ep.clientQuery);
      if (redirect) return c.redirect(redirect, 302);
    }
    let upstream: Response;
    try {
      upstream = await forward(ep);
    } catch {
      upstream = new Response(null, { status: 502 });
    }
    // A stale preview link (sandbox stopped/rotated since we cached it) surfaces
    // as a transport failure or a 5xx, a stale credential (expired Box port
    // cookie) as a 401/403 — re-resolve once (wakes the box, fresh auth) and retry.
    if (isStalePreviewResponse(upstream)) {
      invalidateDesktopPreview(threadId);
      await ensureDesktopPreview(threadId, expectedSandbox);
      invalidatePreviewEndpoint(threadId, DESKTOP_PORT);
      ep = await resolvePreviewEndpoint(threadId, DESKTOP_PORT, true, expectedSandbox);
      if (subpath === "/vnc.html") {
        const redirect = desktopClientQueryRedirect(url, ep.clientQuery);
        if (redirect) return c.redirect(redirect, 302);
      }
      upstream = await forward(ep);
    }
    return buildProxyResponse(subpath === "/vnc.html" ? await servedClientPage(upstream) : upstream);
  } catch (err) {
    invalidateDesktopPreview(threadId);
    invalidatePreviewEndpoint(threadId, DESKTOP_PORT);
    const msg = errorMessage(err);
    if (msg === "no-sandbox") {
      return c.json(
        { error: "no live sandbox for this conversation yet - send a message first" },
        409,
      );
    }
    return c.json({ error: `desktop proxy failed: ${msg}` }, 502);
  }
});

// Session entry: every product URL (the pane's vnc.html, an old tab's asset)
// re-enters through a freshly minted view. vnc.html is also the lifecycle
// boundary for clients that skip /ready, so it is repaired before the redirect.
desktopProxyRoutes.all("/:threadId/*", async (c) => {
  const threadId = c.req.param("threadId") ?? "";
  const orgId = c.get("orgId");

  const run = await getRunForOrg(orgId, threadId);
  if (!run) {
    return c.json({ error: "thread not found" }, 404);
  }

  const url = new URL(c.req.url);
  const subpath = url.pathname.slice(`/api/desktop-proxy/${threadId}`.length) || "/";
  if (subpath === "/vnc.html") {
    try {
      await ensureDesktopPreview(threadId, run.expectedSandbox ?? await getThreadExpectedSandbox(orgId, threadId));
    } catch (err) {
      const message = errorMessage(err);
      if (message === "no-sandbox") {
        return c.json({ error: "no live sandbox for this conversation yet - send a message first" }, 409);
      }
      return c.json({ error: `desktop proxy failed: ${message}` }, 502);
    }
  }

  const view = previewViewPrefix("/api/desktop-proxy", {
    orgId, userId: c.get("userId"), threadId, port: DESKTOP_PORT, kind: "desktop",
  });
  const target = new URL(`${view}${subpath}${url.search}`, url);
  // noVNC opens its socket from `path`. Current noVNC resolves it relative to
  // vnc.html, a legacy client concatenates `ws(s)://host/` + path; the
  // traversal form lands on the same view in both.
  if (subpath === "/vnc.html") {
    target.searchParams.set("path", `${"../".repeat(view.split("/").length - 1)}${view.slice(1)}/websockify`);
  }
  return c.redirect(`${target.pathname}${target.search}`, 307);
});
