import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { auth } from "../auth";
import { invitationMailEnabled } from "../auth-invitations";
import { db } from "../db/client";
import { invitation, member } from "../db/auth-schema";
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
 *  so an admin could extend an owner invitation by asking for "member". Only an
 *  owner may resend an owner invitation. */
routes.post("/api/auth/organization/invite-member", async (c) => {
  const request = c.req.raw;
  const text = await request.clone().text();
  let body: { email?: unknown; resend?: unknown; organizationId?: unknown } = {};
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    // better-auth answers malformed bodies itself
  }
  if (body.resend === true && typeof body.email === "string") {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return c.json({ message: "Not authenticated" }, 401);
    const organizationId =
      typeof body.organizationId === "string" ? body.organizationId : session.session.activeOrganizationId ?? null;
    if (organizationId) {
      const [pending] = await db
        .select({ role: invitation.role })
        .from(invitation)
        .where(
          and(
            eq(invitation.organizationId, organizationId),
            eq(invitation.email, body.email.toLowerCase()),
            eq(invitation.status, "pending"),
          ),
        )
        .limit(1);
      if (pending?.role?.split(",").map((role) => role.trim()).includes("owner")) {
        const [membership] = await db
          .select({ role: member.role })
          .from(member)
          .where(and(eq(member.organizationId, organizationId), eq(member.userId, session.user.id)))
          .limit(1);
        if (!membership?.role.split(",").map((role) => role.trim()).includes("owner")) {
          return c.json({ message: "Only an owner can resend an owner invitation" }, 403);
        }
      }
    }
  }
  return auth.handler(request);
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
