import { and, desc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { invitation, member, user } from "../db/auth-schema";
import { NO_WAY_IN } from "../auth-invitations";
import { decideAccessRequest, listAccessRequests } from "../slack/access-requests";
import type { AppEnv } from "../http";

/**
 * The organisation's open invitations. better-auth's own list returns every
 * invitation ever made, capped at 100 rows, so a workspace with a history of
 * cancelled invites would hide the live ones. This reads only what is pending
 * and unexpired, for the org the request is scoped to.
 */
export const teamRoutes = new Hono<AppEnv>();

teamRoutes.get("/invitations", async (c) => {
  const orgId = c.get("orgId");
  if (!orgId) return c.json({ error: "forbidden" }, 403);
  const rows = await db
    .select({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
    })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, orgId),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(invitation.createdAt))
    .limit(200);
  return c.json({
    organizationId: orgId,
    invitations: rows.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
  });
});

/** Slack senders waiting to be let in, and the admin's answer. Owners and admins only. */
async function managerId(c: { get(key: "orgId"): string | undefined; get(key: "userId"): string | undefined }): Promise<{ orgId: string; userId: string } | null> {
  const orgId = c.get("orgId");
  const userId = c.get("userId");
  if (!orgId || !userId) return null;
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1);
  const roles = (row?.role ?? "").split(",").map((role) => role.trim());
  return roles.includes("owner") || roles.includes("admin") ? { orgId, userId } : null;
}

teamRoutes.get("/access-requests", async (c) => {
  const manager = await managerId(c);
  if (!manager) return c.json({ error: "forbidden" }, 403);
  return c.json({ requests: await listAccessRequests(manager.orgId) });
});

teamRoutes.post("/access-requests/:id/:answer{allow|deny}", async (c) => {
  const manager = await managerId(c);
  if (!manager) return c.json({ error: "forbidden" }, 403);
  const body = (await c.req.json().catch(() => ({}))) as { email?: unknown };
  const [who] = await db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, manager.userId)).limit(1);
  const outcome = await decideAccessRequest({
    id: c.req.param("id"),
    orgId: manager.orgId,
    decidedBy: { id: manager.userId, name: who?.name ?? "", email: who?.email ?? "" },
    allow: c.req.param("answer") === "allow",
    email: typeof body.email === "string" ? body.email : null,
  });
  if (outcome === "not_found") return c.json({ message: "That request is no longer open" }, 404);
  if (outcome === "email_required") return c.json({ message: "Enter the email address they will sign in with" }, 400);
  if (outcome === "email_invalid") return c.json({ message: "That does not look like an email address" }, 400);
  if (outcome === "no_way_in") return c.json({ message: NO_WAY_IN }, 400);
  return c.json({ status: outcome });
});
