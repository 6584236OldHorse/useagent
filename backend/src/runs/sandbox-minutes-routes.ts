import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { sandboxMinutesSnapshot } from "./sandbox-minutes";

// GET /api/sandbox-minutes - the signed-in member's settled sandbox minutes
// against their cap, the figure Settings > Usage shows.
export const sandboxMinutesRoutes = new Hono<AppEnv>();

sandboxMinutesRoutes.use("*", orgScope);

sandboxMinutesRoutes.get("/", async (c) => c.json(await sandboxMinutesSnapshot(c.get("orgId"), c.get("userId"))));
