import { and, desc, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { invitation } from "../db/auth-schema";
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
    invitations: rows.map((row) => ({
      id: row.id,
      email: row.email,
      role: row.role,
      expiresAt: row.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
    })),
  });
});
