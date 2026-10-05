import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../http";
import { mintSignedCapability, verifySignedCapability } from "../security/signed-capability";

// ---------------------------------------------------------------------------
// PREVIEW CAPABILITY - how a sandbox-served page authenticates without the
// product session. Every desktop and port preview response carries a CSP
// `sandbox` (preview-proxy.ts), so the page runs in an opaque origin: it cannot
// read product cookies or storage, and the browser attaches no session cookie
// to its requests. The session route therefore mints a short-lived capability
// bound to org, user, thread and port, and redirects to
//
//   /api/<desktop|port>-proxy/<threadId>/view/<capability>/<path>
//
// so every relative asset, fetch and socket of the page carries it.
// ---------------------------------------------------------------------------

const PREVIEW_CAPABILITY_TTL_MS = 10 * 60_000;
const OPTIONS = { deriveLabel: "useagent-sandbox-preview-v1" };
const VIEW_PATH = /^(\/api\/(desktop|port)-proxy)\/([^/]+)\/view\/([^/]+)(\/.*)?$/;

export type PreviewKind = "desktop" | "port";

export interface PreviewGrant {
  readonly orgId: string;
  readonly userId: string | null;
  readonly threadId: string;
  readonly port: number;
  readonly kind: PreviewKind;
}

interface PreviewView {
  readonly base: string;
  readonly kind: PreviewKind;
  readonly threadId: string;
  readonly capability: string;
  readonly subpath: string;
}

/** A capability-authenticated preview path, or null for every other path. */
export function parsePreviewViewPath(path: string): PreviewView | null {
  const match = VIEW_PATH.exec(path);
  if (!match) return null;
  const [, base = "", kind, threadId = "", capability = "", subpath] = match;
  return { base, kind: kind === "desktop" ? "desktop" : "port", threadId, capability, subpath: subpath || "/" };
}

/** Mint a view for an authenticated session; returns the path prefix the page is served under. */
export function previewViewPrefix(base: string, grant: PreviewGrant): string {
  const capability = mintSignedCapability(
    { o: grant.orgId, u: grant.userId, t: grant.threadId, p: grant.port, k: grant.kind },
    PREVIEW_CAPABILITY_TTL_MS,
    OPTIONS,
  );
  return `${base}/${grant.threadId}/view/${capability}`;
}

/** The grant a view's capability carries, when it is authentic, unexpired and for this exact path. */
export function verifyPreviewView(view: PreviewView, nowMs = Date.now()): PreviewGrant | null {
  const verified = verifySignedCapability(view.capability, OPTIONS, nowMs);
  const claims = verified?.claims as { o?: unknown; u?: unknown; t?: unknown; p?: unknown; k?: unknown } | undefined;
  if (
    !claims ||
    typeof claims.o !== "string" ||
    (claims.u !== null && typeof claims.u !== "string") ||
    claims.t !== view.threadId ||
    claims.k !== view.kind ||
    typeof claims.p !== "number"
  ) {
    return null;
  }
  return { orgId: claims.o, userId: claims.u, threadId: view.threadId, port: claims.p, kind: view.kind };
}

/** Authenticates capability paths in place of the session; every other path passes through untouched. */
export const previewCapabilityScope = createMiddleware<AppEnv>(async (c, next) => {
  const view = parsePreviewViewPath(c.req.path);
  if (!view) return next();
  const grant = verifyPreviewView(view);
  if (!grant) {
    // A reload after expiry re-enters through the session route, which mints a
    // fresh view. Signature-checked (expiry ignored) so the target is ours.
    const lapsed = c.req.header("sec-fetch-mode") === "navigate" ? verifyPreviewView(view, 0) : null;
    if (lapsed) {
      const port = lapsed.kind === "port" ? `/${lapsed.port}` : "";
      return c.redirect(`${view.base}/${view.threadId}${port}${view.subpath}${new URL(c.req.url).search}`, 302);
    }
    return c.json({ error: "This preview link expired. Open it again from the conversation." }, 401);
  }
  // The page's own non-simple requests (a JSON POST) preflight from its opaque
  // origin. No ambient credential is involved: the capability authorizes them.
  const preflight = c.req.method === "OPTIONS" ? c.req.header("access-control-request-method") : undefined;
  if (preflight) {
    return c.body(null, 204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": preflight,
      "Access-Control-Allow-Headers": c.req.header("access-control-request-headers") ?? "",
      "Access-Control-Max-Age": "600",
    });
  }
  c.set("orgId", grant.orgId);
  c.set("userId", grant.userId);
  c.set("previewPort", grant.port);
  return next();
});
