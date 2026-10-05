import { Hono } from "hono";
import { auth } from "../auth";
import { allowDevOrg, googleAuthEnabled } from "../env";
import type { AppEnv } from "../http";

const routes = new Hono<AppEnv>();
routes.get("/api/auth/provider-config", (c) =>
  c.json({
    google: googleAuthEnabled(),
    emailPassword: true,
    allowDevOrg: allowDevOrg(),
  }),
);
routes.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

export function handleAuthRequest(request: Request): Response | Promise<Response> {
  return routes.fetch(request);
}
