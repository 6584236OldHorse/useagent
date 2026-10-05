import { createMiddleware } from "hono/factory";
import { env } from "../env";
import type { AppEnv } from "../http";

/** Cookie-authenticated browser sockets must not trust a foreign page's Origin.
 * HTTP CORS does not authorize WebSocket upgrades. Ordinary HTTP is unchanged. */
export const requireBrowserWebSocketOrigin = createMiddleware<AppEnv>(async (c, next) => {
  if (
    c.req.header("upgrade") !== undefined &&
    c.req.header("origin") !== new URL(env.FRONTEND_ORIGIN).origin
  ) {
    return c.json({ error: "forbidden_origin" }, 403);
  }
  return next();
});
