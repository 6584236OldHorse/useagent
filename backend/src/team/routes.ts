import { and, desc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { invitation, member, user } from "../db/auth-schema";
import { NO_WAY_IN } from "../auth-invitations";
import { withOrgLock } from "../org-lock";
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

/** Slack senders waiting to be let in, and the admin's answer. Owners and admins
 *  of the organisation the caller names (else the request's scope); a decision
 *  is authorised and made inside the organisation's turn, so a manager whose
 *  rank was just taken away gets nothing done, and mail goes out afterwards. */
async function managerOf(organizationId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .limit(1);
  const roles = (row?.role ?? "").split(",").map((role) => role.trim());
  return roles.includes("owner") || roles.includes("admin");
}

teamRoutes.get("/access-requests", async (c) => {
  const organizationId = c.req.query("organizationId")?.trim() || c.get("orgId");
  const userId = c.get("userId");
  if (!organizationId || !userId || !(await managerOf(organizationId, userId))) return c.json({ error: "forbidden" }, 403);
  return c.json({ organizationId, requests: await listAccessRequests(organizationId) });
});

teamRoutes.post("/access-requests/:id/:answer{allow|deny}", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; organizationId?: unknown };
  const organizationId = (typeof body.organizationId === "string" && body.organizationId.trim()) || c.get("orgId");
  const userId = c.get("userId");
  if (!organizationId || !userId) return c.json({ error: "forbidden" }, 403);
  const decision = await withOrgLock(organizationId, async () => {
    if (!(await managerOf(organizationId, userId))) return null;
    const [who] = await db.select({ name: user.name, email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
    return decideAccessRequest({
      id: c.req.param("id"),
      orgId: organizationId,
      decidedBy: { id: userId, name: who?.name ?? "", email: who?.email ?? "" },
      allow: c.req.param("answer") === "allow",
      email: typeof body.email === "string" ? body.email : null,
    });
  });
  if (!decision) return c.json({ error: "forbidden" }, 403);
  // The decision is committed; mail is best effort and never turns it into a failure.
  try {
    await decision.deliver?.();
  } catch (error) {
    console.error(`[slack] access request ${c.req.param("id")}: mail after the decision failed:`, (error as Error).message);
  }
  const { outcome } = decision;
  if (outcome === "not_found") return c.json({ message: "That request is no longer open" }, 404);
  if (outcome === "email_required") return c.json({ message: "Enter the email address they will sign in with" }, 400);
  if (outcome === "email_invalid") return c.json({ message: "That does not look like an email address" }, 400);
  if (outcome === "no_way_in") return c.json({ message: NO_WAY_IN }, 400);
  return c.json({ status: outcome });
});
