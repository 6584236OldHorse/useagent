import {
  sandboxPreviewHeaders,
  type SandboxHandle,
  previewLinkBase,
} from "../sandboxes/provider";
import {
  forgetLiveThreadSandbox,
  getLiveThreadSandbox,
  rememberLiveThreadSandbox,
} from "../engines/sandbox-runtime";
import { getThreadSandbox } from "./repo";
import { resolveExpectedSandbox, resolveSandboxBindingForSandbox } from "../sandboxes/binding";
import type { ExpectedSandboxBinding } from "../sandboxes/expected-binding";

// ---------------------------------------------------------------------------
// PREVIEW PROXY — shared machinery for the same-origin bridges that expose a
// service running INSIDE a thread's Daytona sandbox to the browser without CORS
// or a leaked preview token: the opencode server on :4096 (the "Live" tab, see
// the thread stream) and the noVNC desktop on :6080 (the "Desktop" tab, see
// desktop-proxy.ts). It resolves the thread's sandbox, wakes it if stopped, and
// caches the per-port preview endpoint (url + token); the caller forwards
// requests with the token injected server-side.
// ---------------------------------------------------------------------------

/** Cached preview auth is re-minted after this long even without an error (Box port cookies expire). */
const PREVIEW_ENDPOINT_TTL_MS = 6 * 60 * 60 * 1000;

/** Upstream answers that mean the cached link or its credential is stale, not the app. */
export function isStalePreviewResponse(upstream: Response): boolean {
  return upstream.status === 401 || upstream.status === 403 || upstream.status === 502 || upstream.status === 503;
}

export interface PreviewEndpoint {
  sandboxId: string;
  baseUrl: string;
  token: string;
  /** Auth headers every upstream request must carry (provider token header or Box's port-auth cookie). */
  headers: Readonly<Record<string, string>>;
  /** Provider-issued values that must be reflected in the browser-side preview URL. */
  clientQuery?: Readonly<Record<string, string>>;
  resolvedAt: number;
}

/** Per (thread, port) preview endpoint cache. A thread now exposes several ports
 *  (4096 opencode, 6080 desktop), so the key carries the port. Cheap to rebuild
 *  (a backend restart re-resolves); invalidated + re-resolved on the first
 *  upstream failure so a stopped/rotated sandbox self-heals (getPreviewLink after
 *  start() wakes it). */
const endpoints = new Map<string, PreviewEndpoint>();

/** Product credentials and caller identity must not reach sandbox services. */
const STRIP_REQUEST = new Set([
  "host",
  "connection",
  "content-length",
  "accept-encoding",
  "cookie",
  "authorization",
  "proxy-authorization",
  "forwarded",
  "x-forwarded",
  "x-real-ip",
  "cube-traffic-access-token",
  "e2b-traffic-access-token",
  "x-daytona-preview-token",
]);
const STRIP_RESPONSE = new Set([
  "connection",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "set-cookie",
  "set-cookie2",
  "clear-site-data",
  "service-worker-allowed",
]);

export async function resolvePreviewEndpoint(
  threadId: string,
  port: number,
  force = false,
  expectedSandbox?: ExpectedSandboxBinding | null,
): Promise<PreviewEndpoint> {
  const key = `${threadId}:${port}`;
  if (!force && !expectedSandbox) {
    const cached = endpoints.get(key);
    if (cached && Date.now() - cached.resolvedAt < PREVIEW_ENDPOINT_TTL_MS) return cached;
  }
  let sandbox = await resolvePreviewSandbox(threadId, expectedSandbox);
  let link: Awaited<ReturnType<SandboxHandle["getPreviewLink"]>>;
  try {
    link = await sandbox.getPreviewLink(port);
  } catch (error) {
    if (expectedSandbox) throw error;
    // A process-local SDK object can outlive a Daytona-side rotation. Evict it
    // and retry once through the durable mapping instead of pinning every
    // subsequent preview request to a dead object.
    forgetLiveThreadSandbox(threadId, sandbox.id);
    sandbox = await resolvePreviewSandbox(threadId);
    link = await sandbox.getPreviewLink(port);
  }
  const ep: PreviewEndpoint = {
    sandboxId: sandbox.id,
    ...previewLinkBase(link),
    resolvedAt: Date.now(),
  };
  if (!expectedSandbox) endpoints.set(key, ep);
  return ep;
}

/** Resolve and wake the durable Daytona sandbox behind a thread. Kept beside
 * preview-link resolution so terminal/desktop proxies do not duplicate sandbox
 * identity or lifecycle rules. */
export async function resolvePreviewSandbox(
  threadId: string,
  expectedSandbox?: ExpectedSandboxBinding | null,
): Promise<SandboxHandle> {
  if (expectedSandbox) {
    const sandbox = await resolveExpectedSandbox(expectedSandbox, threadId);
    const state = (sandbox as { state?: string }).state;
    if (state === "stopped" || state === "paused" || state === "archived") await sandbox.start();
    return sandbox;
  }
  const cached = getLiveThreadSandbox(threadId);
  if (cached) {
    const state = (cached as { state?: string }).state;
    if (state === "stopped" || state === "paused" || state === "archived") {
      try {
        await cached.start();
        return cached;
      } catch {
        forgetLiveThreadSandbox(threadId, cached.id);
      }
    } else if (state === undefined || state === "started") {
      return cached;
    } else {
      forgetLiveThreadSandbox(threadId, cached.id);
    }
  }

  const sandboxId = await getThreadSandbox(threadId);
  if (!sandboxId) throw new Error("no-sandbox");

  const provider = (await resolveSandboxBindingForSandbox(sandboxId)).provider;
  const sandbox = await provider.get(sandboxId);
  const state = (sandbox as { state?: string }).state;
  if (state === "stopped" || state === "paused" || state === "archived") {
    await sandbox.start();
  }
  rememberLiveThreadSandbox(threadId, sandbox);
  return sandbox;
}

/** Drop a cached endpoint so the next resolve re-fetches (and wakes the box). */
export function invalidatePreviewEndpoint(threadId: string, port: number): void {
  endpoints.delete(`${threadId}:${port}`);
}

export function buildForwardHeaders(src: Headers, auth: Readonly<Record<string, string>>): Headers {
  const headers = new Headers();
  src.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (!STRIP_REQUEST.has(normalized) && !normalized.startsWith("x-forwarded-")) {
      headers.set(key, value);
    }
  });
  for (const [name, value] of Object.entries(auth)) {
    headers.set(name, value);
  }
  return headers;
}

/** Sandbox-authored bytes render in an opaque origin, never as the product:
 *  no product cookies, storage or same-origin API access. Mirrored by the
 *  desktop pane's iframe `sandbox` attribute and the desktop app's frame policy. */
export const PREVIEW_SANDBOX_POLICY = "sandbox allow-scripts allow-forms allow-popups allow-downloads";

export function buildProxyResponse(upstream: Response): Response {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STRIP_RESPONSE.has(key.toLowerCase())) headers.set(key, value);
  });
  headers.set("Content-Security-Policy", PREVIEW_SANDBOX_POLICY);
  headers.set("X-Content-Type-Options", "nosniff");
  // The opaque page loads its own module scripts and data cross-origin. The
  // capability in the URL authorizes them, never an ambient credential.
  headers.set("Access-Control-Allow-Origin", "*");
  // SSE hygiene — mirror runs/routes.ts: stop any proxy buffering/transforming
  // an event-stream so token deltas arrive live in the embed.
  if ((upstream.headers.get("content-type") ?? "").includes("text/event-stream")) {
    headers.set("Cache-Control", "no-cache, no-transform");
    headers.set("X-Accel-Buffering", "no");
    headers.set("Connection", "keep-alive");
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
