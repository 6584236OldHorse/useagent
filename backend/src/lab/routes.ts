import { Hono } from "hono";

import { resolveSession } from "../auth/session";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { labAccessAllowed } from "./access";

export const labRoutes = new Hono<AppEnv>();
labRoutes.use("*", orgScope);

// The frontend asks this before rendering /lab and before listing it in the
// command palette. The dev identity has no email, so outside dev mode it is refused.
labRoutes.get("/access", async (c) => {
  const session = c.get("identitySource") === "session" ? await resolveSession(c.req.raw.headers) : null;
  if (!labAccessAllowed(session?.user.email)) return c.json({ error: "lab_not_allowed" }, 403);
  return c.json({ ok: true });
});
