import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { auth } from "../auth";
import { db } from "../db/client";
import { member, organization, user } from "../db/auth-schema";
import { allowDevOrg, googleAuthEnabled } from "../env";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { handleIdentityWebhook } from "./clerk/webhook";
import { authProvider, IdentityAccessError, resolveSession } from "./session";

const routes = new Hono<AppEnv>();
routes.post("/api/auth/clerk/webhook", bodyLimit({ maxSize: 1024 * 1024 }), (c) =>
  handleIdentityWebhook(c.req.raw),
);
routes.get("/api/auth/provider-config", (c) =>
  c.json({ google: googleAuthEnabled(), emailPassword: true, allowDevOrg: allowDevOrg() }),
);
routes.use("/api/auth/*", (c, next) =>
  authProvider() === "better-auth" ? auth.handler(c.req.raw) : next(),
);

routes.get("/api/auth/get-session", orgScope, async (c) =>
  c.json(await resolveSession(c.req.raw.headers)),
);
routes.get("/api/auth/organization/list", orgScope, async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const rows = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      logo: organization.logo,
      metadata: organization.metadata,
      createdAt: organization.createdAt,
    })
    .from(organization)
    .innerJoin(member, eq(member.organizationId, organization.id))
    .where(eq(member.userId, userId))
    .orderBy(
      sql`CASE WHEN ${organization.id} = ${c.get("orgId")} THEN 0 ELSE 1 END`,
      organization.createdAt,
      organization.id,
    );
  return c.json(rows);
});
routes.get("/api/auth/organization/list-members", orgScope, async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "unauthorized" }, 401);
  const orgId = c.req.query("organizationId") ?? c.get("orgId");
  const [allowed] = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1);
  if (!allowed) return c.json({ error: "forbidden" }, 403);
  const rows = await db
    .select({
      id: member.id,
      organizationId: member.organizationId,
      userId: member.userId,
      role: member.role,
      createdAt: member.createdAt,
      user: { id: user.id, name: user.name, email: user.email, image: user.image },
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, orgId));
  return c.json({ members: rows, total: rows.length });
});
routes.onError((error, c) =>
  error instanceof IdentityAccessError
    ? c.json({ error: error.code }, 403)
    : c.json({ error: "identity_unavailable" }, 503),
);

export function handleAuthRequest(request: Request): Response | Promise<Response> {
  return routes.fetch(request);
}
