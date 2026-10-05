import { and, eq, gt, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { auth } from "../auth";
import { INVITATION_EXPIRES_IN_SECONDS, deliverInvitation, invitationMailEnabled } from "../auth-invitations";
import { db } from "../db/client";
import { invitation, member, organization, user } from "../db/auth-schema";
import { allowDevOrg, betterAuthTrustedOrigins, googleAuthEnabled } from "../env";
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

function trustedOrigin(request: Request): boolean {
  const referer = request.headers.get("referer");
  let origin = request.headers.get("origin");
  if (!origin && referer) {
    try {
      origin = new URL(referer).origin;
    } catch {
      return false;
    }
  }
  return !!origin && betterAuthTrustedOrigins().includes(origin);
}

/** The same trimming gap applies when a role is changed. */
routes.post("/api/auth/organization/update-member-role", async (c) => {
  const request = c.req.raw;
  let role: unknown;
  try {
    role = ((await request.clone().json()) as { role?: unknown } | null)?.role;
  } catch {
    return auth.handler(request);
  }
  if (role !== undefined && !exactRole(role)) return c.json({ message: ROLE_MESSAGE }, 400);
  return auth.handler(request);
});
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
    return auth.handler(request);
  }
  // Answered outside the library, so its origin check is repeated here.
  if (!trustedOrigin(request)) return c.json({ message: "Invalid origin" }, 403);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return c.json({ message: "Not authenticated" }, 401);
  const organizationId =
    typeof body.organizationId === "string" && body.organizationId.trim()
      ? body.organizationId.trim()
      : session.session.activeOrganizationId ?? null;
  if (!organizationId) return c.json({ message: "Organization not found" }, 400);
  const roles = (value: string | null | undefined) => (value ?? "").split(",").map((role) => role.trim());
  const [membership] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, session.user.id)))
    .limit(1);
  const mine = roles(membership?.role);
  if (!mine.includes("owner") && !mine.includes("admin")) {
    return c.json({ message: "You are not allowed to invite people to this workspace" }, 403);
  }
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
