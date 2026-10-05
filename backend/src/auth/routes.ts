import { and, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { auth } from "../auth";
import { invitationMailEnabled } from "../auth-invitations";
import { db } from "../db/client";
import { invitation, member, organization, user } from "../db/auth-schema";
import { allowDevOrg, googleAuthEnabled } from "../env";
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
/** A resend repeats the invitation as stored, whatever role the request names,
 *  so an admin could extend an owner invitation by asking for "member". The
 *  organisation is resolved once here and pinned on the forwarded request, and
 *  every live invitation for that email is checked: if any is an owner
 *  invitation, only an owner may resend. */
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
  if (body.resend !== true || typeof body.email !== "string") return auth.handler(request);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return c.json({ message: "Not authenticated" }, 401);
  const organizationId =
    typeof body.organizationId === "string" && body.organizationId.trim()
      ? body.organizationId.trim()
      : session.session.activeOrganizationId ?? null;
  if (!organizationId) return auth.handler(request); // better-auth reports the missing organisation
  const live = await db
    .select({ role: invitation.role })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, organizationId),
        eq(invitation.email, body.email.trim().toLowerCase()),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
      ),
    );
  const roles = (value: string | null | undefined) => (value ?? "").split(",").map((role) => role.trim());
  if (live.some((row) => roles(row.role).includes("owner"))) {
    const [membership] = await db
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, organizationId), eq(member.userId, session.user.id)))
      .limit(1);
    if (!roles(membership?.role).includes("owner")) {
      return c.json({ message: "Only an owner can resend an owner invitation" }, 403);
    }
  }
  const pinned = new Request(request, { body: JSON.stringify({ ...body, organizationId }) });
  pinned.headers.set("content-type", "application/json");
  return auth.handler(pinned);
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
