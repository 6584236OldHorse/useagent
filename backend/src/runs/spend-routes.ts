import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { spendSnapshot } from "./spend";

// GET /api/spend - the signed-in member's settled spend against their allowance,
// the figure the composer chip and Settings > Usage show.
export const spendRoutes = new Hono<AppEnv>();

spendRoutes.use("*", orgScope);

spendRoutes.get("/", async (c) => c.json(await spendSnapshot(c.get("orgId"), c.get("userId"))));
