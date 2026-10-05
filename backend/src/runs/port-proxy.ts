import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { getRunForOrg } from "./repo";
import { PORT_PROXY_PATH } from "./port-proxy-url";
import { previewCapabilityScope, previewViewPrefix } from "./preview-capability";
import {
  buildForwardHeaders,
  buildProxyResponse,
  invalidatePreviewEndpoint,
  isStalePreviewResponse,
  resolvePreviewEndpoint,
  type PreviewEndpoint,
} from "./preview-proxy";
import { errorMessage } from "../util/error-message";
import { getThreadExpectedSandbox } from "../sandboxes/binding";
import type { ExpectedSandboxBinding } from "../sandboxes/expected-binding";

// ---------------------------------------------------------------------------
// PORT PROXY - same-origin bridge to ANY port an agent serves inside a thread's
// sandbox ("open what the agent just started"). The live (:4096) and desktop
// (:6080) proxies are pinned to one internal port each; this one takes the port
// from the path so a dev server, a static directory or a preview the agent
// serves has a product URL that opens for the customer:
//
//   browser → /api/port-proxy/<threadId>/<port>/<path>          (session)
//           → mint a preview capability, redirect to
//             /api/port-proxy/<threadId>/view/<cap>/<path>
//           → resolve the thread's preview endpoint for that port (waking the
//             box if needed), inject the provider's preview credential
//             server-side, forward verbatim, stream the response back under a
//             CSP sandbox (opaque origin, see preview-capability.ts).
//
// The agent is told this URL shape in its turn prompt (runs/port-proxy-url.ts)
// so its answer links to something that opens instead of localhost.
// ---------------------------------------------------------------------------

export function parsePreviewPort(raw: string): number | null {
  if (!/^\d{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65_535 ? port : null;
}

/** Keep an app's own absolute-path redirects inside the bridge. */
export function rewriteProxyLocation(location: string | null, prefix: string): string | null {
  if (!location || !location.startsWith("/") || location.startsWith(`${prefix}/`)) return null;
  return `${prefix}${location}`;
}

export interface PortProxyDeps {
  readonly threadBinding: (orgId: string, threadId: string) => Promise<{ expectedSandbox: ExpectedSandboxBinding | null } | null>;
  readonly resolveEndpoint: typeof resolvePreviewEndpoint;
  readonly invalidateEndpoint: (threadId: string, port: number) => void;
  readonly fetch: typeof fetch;
}

export function createPortProxyRoutes(
  deps: PortProxyDeps,
  scope: MiddlewareHandler<AppEnv> = orgScope,
): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  routes.use("*", previewCapabilityScope);
  routes.use("*", scope);

  // The bare `/<thread>/<port>` serves the root too: the frontend's API rewrite
  // hands the backend the path without its trailing slash while the browser
  // keeps it, so a redirect here would loop and a 404 would hide the app.
  routes.all("/:threadId/view/:capability", (c) => proxyPort(c));
  routes.all("/:threadId/view/:capability/*", (c) => proxyPort(c));
  routes.all("/:threadId/:port", (c) => enterPort(c));
  routes.all("/:threadId/:port/*", (c) => enterPort(c));

  // Org gate: a thread id IS its root run's id, so this both authorizes the org
  // and 404s a cross-org or unknown thread (indistinguishable, as elsewhere).
  async function enterPort(c: Context<AppEnv>): Promise<Response> {
    const threadId = c.req.param("threadId") ?? "";
    const rawPort = c.req.param("port") ?? "";
    const port = parsePreviewPort(rawPort);
    if (port === null) return c.json({ error: "port must be a number from 1 to 65535" }, 400);
    if (!await deps.threadBinding(c.get("orgId"), threadId)) {
      return c.json({ error: "thread not found" }, 404);
    }
    const url = new URL(c.req.url);
    const subpath = url.pathname.slice(`${PORT_PROXY_PATH}/${threadId}/${rawPort}`.length) || "/";
    const view = previewViewPrefix(PORT_PROXY_PATH, {
      orgId: c.get("orgId"), userId: c.get("userId"), threadId, port, kind: "port",
    });
    return c.redirect(`${view}${subpath}${url.search}`, 307);
  }

  async function proxyPort(c: Context<AppEnv>): Promise<Response> {
    const threadId = c.req.param("threadId") ?? "";
    const port = c.get("previewPort");
    if (port === undefined) return c.json({ error: "thread not found" }, 404);
    const binding = await deps.threadBinding(c.get("orgId"), threadId);
    if (!binding) {
      return c.json({ error: "thread not found" }, 404);
    }

    const url = new URL(c.req.url);
    const prefix = `${PORT_PROXY_PATH}/${threadId}/view/${c.req.param("capability") ?? ""}`;
    const subpath = url.pathname.slice(prefix.length) || "/";
    const method = c.req.method;
    const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();

    const forward = (ep: PreviewEndpoint): Promise<Response> =>
      deps.fetch(`${ep.baseUrl}${subpath}${url.search}`, {
        method,
        headers: buildForwardHeaders(c.req.raw.headers, ep.headers),
        body,
        redirect: "manual",
        signal: c.req.raw.signal,
      });

    try {
      let ep = await deps.resolveEndpoint(threadId, port, false, binding.expectedSandbox);
      let upstream: Response;
      try {
        upstream = await forward(ep);
      } catch {
        upstream = new Response(null, { status: 502 });
      }
      // A stale preview link (box stopped or rotated) or an expired preview
      // credential answers 401/403/5xx: re-resolve once (wakes the box, fresh
      // auth) and retry before reporting the port as dead.
      if (isStalePreviewResponse(upstream)) {
        ep = await deps.resolveEndpoint(threadId, port, true, binding.expectedSandbox);
        upstream = await forward(ep);
      }
      if (upstream.status === 502) {
        return c.json(
          { error: `nothing is listening on port ${port} in this conversation's sandbox` },
          502,
        );
      }
      const response = buildProxyResponse(upstream);
      const location = rewriteProxyLocation(response.headers.get("location"), prefix);
      if (location) response.headers.set("location", location);
      return response;
    } catch (err) {
      deps.invalidateEndpoint(threadId, port);
      const msg = errorMessage(err);
      if (msg === "no-sandbox") {
        return c.json(
          { error: "no live sandbox for this conversation yet - send a message first" },
          409,
        );
      }
      return c.json({ error: `port proxy failed: ${msg}` }, 502);
    }
  }
  return routes;
}

export const portProxyRoutes = createPortProxyRoutes({
  threadBinding: async (orgId, threadId) => {
    const run = await getRunForOrg(orgId, threadId);
    return run ? { expectedSandbox: run.expectedSandbox ?? await getThreadExpectedSandbox(orgId, threadId) } : null;
  },
  resolveEndpoint: resolvePreviewEndpoint,
  invalidateEndpoint: invalidatePreviewEndpoint,
  fetch,
});
