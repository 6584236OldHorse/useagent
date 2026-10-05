import { and, eq, gt, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { auth } from "../auth";
import { INVITATION_EXPIRES_IN_SECONDS, NO_WAY_IN, canSignIn, deliverInvitation, invitationMailEnabled } from "../auth-invitations";
import { db } from "../db/client";
import { invitation, member, organization, user } from "../db/auth-schema";
import { allowDevOrg, betterAuthTrustedOrigins, googleAuthEnabled, selfSignupEnabled } from "../env";
import type { AppEnv } from "../http";

/** Session reads are renderer-reachable (the desktop copies the HttpOnly
 *  cookie into Chromium), so every token-like field leaves the JSON here. */
function withoutTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTokens);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).filter(([key]) => !/token/i.test(key)).map(([key, item]) => [key, withoutTokens(item)]),
    );
  }
  return value;
}

async function redactSessionTokens(response: Response): Promise<Response> {
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(withoutTokens(await response.json())), { status: response.status, headers });
}

const routes = new Hono<AppEnv>();
routes.get("/api/auth/provider-config", (c) =>
  c.json({
    google: googleAuthEnabled(),
    emailPassword: true,
    allowDevOrg: allowDevOrg(),
    invitationEmail: invitationMailEnabled(),
  }),
);
routes.on("GET", ["/api/auth/get-session", "/api/auth/list-sessions"], async (c) =>
  redactSessionTokens(await auth.handler(c.req.raw)),
);
/** Only the native main process may exchange an authorization code for a
 *  session token. Browsers always send their web Origin on a POST and cannot
 *  forge it, so a renderer holding the copied cookie never reaches the exchange. */
routes.post("/api/auth/electron/token", (c) => {
  const origin = c.req.header("origin") ?? c.req.header("electron-origin");
  if (origin !== "useagent:/") return c.json({ message: "Desktop token exchange requires the native app." }, 403);
  return auth.handler(c.req.raw);
});
const ROLE_MESSAGE = "Role must be owner, admin or member";
const exactRole = (value: unknown): boolean => value === "owner" || value === "admin" || value === "member";

/** The library's rule: the origin header, else the referer; http(s) values match
 *  by origin, the desktop scheme by prefix; missing or the literal "null" fails. */
function trustedOrigin(request: Request): boolean {
  const value = request.headers.get("origin") || request.headers.get("referer") || "";
  if (!value || value === "null") return false;
  const trusted = betterAuthTrustedOrigins();
  if (/^https?:\/\//i.test(value)) {
    try {
      return trusted.includes(new URL(value).origin);
    } catch {
      return false;
    }
  }
  return trusted.some((pattern) => value.startsWith(pattern));
}

const roles = (value: string | null | undefined) => (value ?? "").split(",").map((role) => role.trim());

type Refusal = { status: 400 | 401 | 403; message: string };
type Manager = { session: NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>; organizationId: string; roles: string[] };

/** The signed-in owner or admin behind a request, for the organisation it names
 *  or the session's active one. Refusals come before any invitation is read, so
 *  an outsider gets one answer whatever exists. */
async function managerFor(request: Request, body: Record<string, unknown>): Promise<Manager | Refusal> {
  if (!trustedOrigin(request)) return { status: 403, message: "Invalid origin" };
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return { status: 401, message: "Not authenticated" };
  const organizationId =
    typeof body.organizationId === "string" && body.organizationId.trim()
      ? body.organizationId.trim()
      : session.session.activeOrganizationId ?? null;
  if (!organizationId) return { status: 400, message: "Organization not found" };
  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, session.user.id)))
    .limit(1);
  const mine = roles(membership?.role);
  if (!mine.includes("owner") && !mine.includes("admin")) {
    return { status: 403, message: "You are not allowed to invite people to this workspace" };
  }
  return { session, organizationId, roles: mine };
}

// ponytail: process-local, which matches the documented one-backend deployment; a database lock if replicas ever appear.
const orgLocks = new Map<string, Promise<unknown>>();
/** Changes that can reduce an organisation's owners run one at a time per
 *  organisation, so two owners demoting each other at once cannot both succeed. */
function withOrgLock<T>(orgId: string, work: () => Promise<T>): Promise<T> {
  const previous = orgLocks.get(orgId) ?? Promise.resolve();
  const run = previous.then(work, work);
  orgLocks.set(orgId, run.then(() => undefined, () => undefined));
  return run;
}

const LAST_OWNER = "A workspace needs at least one owner. Make someone else an owner first.";

/** Whether the member (by id, or by email for remove-member) is the organisation's only owner. */
async function onlyOwner(organizationId: string, target: { memberId?: string; email?: string; userId?: string }): Promise<boolean> {
  const owners = await db
    .select({ id: member.id, userId: member.userId, email: user.email, role: member.role })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, organizationId));
  const owning = owners.filter((row) => roles(row.role).includes("owner"));
  if (owning.length !== 1) return false;
  const [only] = owning;
  return (
    only!.id === target.memberId ||
    only!.userId === target.userId ||
    (target.email !== undefined && only!.email.toLowerCase() === target.email.toLowerCase())
  );
}

async function organisationOf(request: Request, body: Record<string, unknown>): Promise<string | null> {
  if (typeof body.organizationId === "string" && body.organizationId.trim()) return body.organizationId.trim();
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.session.activeOrganizationId ?? null;
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await request.clone().json()) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

/** The same trimming gap applies when a role is changed, and taking ownership
 *  away from the last owner is refused. */
routes.post("/api/auth/organization/update-member-role", async (c) => {
  const request = c.req.raw;
  const body = await jsonBody(request);
  if (!body) return auth.handler(request);
  if (body.role !== undefined && !exactRole(body.role)) return c.json({ message: ROLE_MESSAGE }, 400);
  const organizationId = await organisationOf(request, body);
  if (!organizationId || body.role === "owner") return auth.handler(request);
  return withOrgLock(organizationId, async () => {
    if (typeof body.memberId === "string" && (await onlyOwner(organizationId, { memberId: body.memberId }))) {
      return c.json({ message: LAST_OWNER }, 400);
    }
    return auth.handler(request);
  });
});

routes.post("/api/auth/organization/remove-member", async (c) => {
  const request = c.req.raw;
  const body = await jsonBody(request);
  if (!body) return auth.handler(request);
  const organizationId = await organisationOf(request, body);
  if (!organizationId) return auth.handler(request);
  return withOrgLock(organizationId, async () => {
    const target = typeof body.memberIdOrEmail === "string" ? body.memberIdOrEmail : "";
    if (target && (await onlyOwner(organizationId, { memberId: target, email: target }))) {
      return c.json({ message: LAST_OWNER }, 400);
    }
    return auth.handler(request);
  });
});

routes.post("/api/auth/organization/leave", async (c) => {
  const request = c.req.raw;
  const body = await jsonBody(request);
  if (!body) return auth.handler(request);
  const session = await auth.api.getSession({ headers: request.headers });
  const organizationId = await organisationOf(request, body);
  if (!session || !organizationId) return auth.handler(request);
  return withOrgLock(organizationId, async () => {
    if (await onlyOwner(organizationId, { userId: session.user.id })) return c.json({ message: LAST_OWNER }, 400);
    return auth.handler(request);
  });
});
const RESEND_WINDOW_MS = 60_000;
const recentResends = new Map<string, number>();
// ponytail: process-local, which matches the documented one-backend deployment; move to the database if replicas ever appear.
function resendAllowed(organizationId: string, email: string): boolean {
  const now = Date.now();
  for (const [key, at] of recentResends) if (now - at > RESEND_WINDOW_MS) recentResends.delete(key);
  const key = `${organizationId}:${email.trim().toLowerCase()}`;
  if (recentResends.has(key)) return false;
  recentResends.set(key, now);
  return true;
}

/** A resend renews the invitation that already exists, with the role stored on
 *  it, never the role the request names. It is answered here in full instead of
 *  being forwarded, so nothing can change between the check and the renewal.
 *  Membership is checked before any invitation is read, so an outsider learns
 *  nothing about a workspace's invitations from the answer. */
routes.post("/api/auth/organization/invite-member", async (c) => {
  const request = c.req.raw;
  const text = await request.clone().text();
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    return auth.handler(request); // better-auth answers malformed bodies itself
  }
  if (body.resend !== true || typeof body.email !== "string") {
    // The library trims role tokens when it validates them but stores the raw
    // string, so "admin, owner" passes as admin and lands as owner. One exact role.
    if (body.role !== undefined && !exactRole(body.role)) return c.json({ message: ROLE_MESSAGE }, 400);
    if (typeof body.email === "string" && !selfSignupEnabled() && !googleAuthEnabled()) {
      // On a closed deployment the manager check comes first, whatever the
      // address, so nobody else can tell from the answer which addresses can sign in.
      const manager = await managerFor(request, body);
      if ("status" in manager) return c.json({ message: manager.message }, manager.status);
      if (!(await canSignIn(body.email))) return c.json({ message: NO_WAY_IN }, 400);
    }
    return auth.handler(request);
  }
  const manager = await managerFor(request, body);
  if ("status" in manager) return c.json({ message: manager.message }, manager.status);
  const { session, organizationId, roles: mine } = manager;
  if (!(await canSignIn(body.email))) return c.json({ message: NO_WAY_IN }, 400);
  const live = await db
    .select({ id: invitation.id, role: invitation.role })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, organizationId),
        eq(invitation.email, body.email.trim().toLowerCase()),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
      ),
    );
  if (live.some((row) => roles(row.role).includes("owner")) && !mine.includes("owner")) {
    return c.json({ message: "Only an owner can resend an owner invitation" }, 403);
  }
  // Answered outside the library, so its request limiter does not apply; one
  // resend per address and organisation per minute bounds the mail it can cause.
  if (live.length && !resendAllowed(organizationId, body.email)) {
    return c.json({ message: "That invitation was resent less than a minute ago. Try again shortly." }, 429);
  }
  const [renewed] = live.length
    ? await db
        .update(invitation)
        .set({ expiresAt: new Date(Date.now() + INVITATION_EXPIRES_IN_SECONDS * 1000) })
        .where(and(inArray(invitation.id, live.map((row) => row.id)), eq(invitation.status, "pending")))
        .returning()
    : [];
  if (!renewed) return c.json({ message: "No pending invitation for that address" }, 400);
  const [org] = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  try {
    await deliverInvitation({
      id: renewed.id,
      email: renewed.email,
      role: renewed.role ?? "member",
      organization: { name: org?.name ?? "" },
      invitation: { expiresAt: renewed.expiresAt },
      inviter: { user: { name: session.user.name, email: session.user.email } },
    });
  } catch (error) {
    // The invitation is renewed either way and the link still works; the mail is best effort.
    console.error(`[auth] invitation ${renewed.id} could not be resent:`, (error as Error).message);
  }
  return c.json(renewed);
});
/** The invitation a link points at, for the person it was sent to. better-auth's
 *  own preview refuses once the inviter has left the organisation, although the
 *  invitation itself still accepts; this one checks only what matters: a
 *  signed-in recipient, a pending invitation that has not expired. */
routes.get("/api/auth/invitation-preview", async (c) => {
  const id = c.req.query("id")?.trim();
  if (!id) return c.json({ message: "Invitation not found" }, 404);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ message: "Not authenticated" }, 401);
  const [row] = await db
    .select({
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      organizationName: organization.name,
      inviterEmail: user.email,
    })
    .from(invitation)
    .innerJoin(organization, eq(organization.id, invitation.organizationId))
    .leftJoin(user, eq(user.id, invitation.inviterId))
    .where(eq(invitation.id, id))
    .limit(1);
  if (!row || row.status !== "pending" || row.expiresAt <= new Date()) {
    return c.json({ message: "Invitation not found" }, 404);
  }
  if (row.email.toLowerCase() !== session.user.email.toLowerCase()) {
    return c.json({ message: "You are not the recipient of the invitation" }, 403);
  }
  return c.json({
    email: row.email,
    role: row.role ?? "member",
    organizationName: row.organizationName,
    inviterEmail: row.inviterEmail,
    expiresAt: row.expiresAt.toISOString(),
  });
});
/** An invitation id must come from the invitation itself (the mail or the
 *  inviter), never from a lookup by the session's email claim: a Google account
 *  can keep a verified claim on an address after the mailbox changed hands. */
routes.on(["GET", "POST"], "/api/auth/organization/list-user-invitations", (c) =>
  c.json({ message: "Not available" }, 404),
);
routes.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

export function handleAuthRequest(request: Request): Response | Promise<Response> {
  return routes.fetch(request);
}
