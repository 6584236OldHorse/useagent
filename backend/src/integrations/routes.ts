import { Hono, type Context, type Handler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { resolveSession } from "../auth/session";
import { env, sameSecret } from "../env";
import type { AppEnv } from "../http";
import { orgAdminScope, orgScope } from "../middleware/org";
import { createIntegrationService, type IntegrationServiceDependencies } from "./service";

function errorStatus(message: string): 400 | 403 | 404 | 409 | 503 {
  if (message.includes("admin route required")) return 403;
  if (message.includes("not found")) return 404;
  if (message.includes("unavailable")) return 503;
  if (message.includes("not connectable") || message.includes("already consumed")) return 409;
  return 400;
}

/** The browser that starts a connect flow holds its state, so a consent link
 *  forwarded to someone else completes nothing in their browser. */
const CONNECT_STATE_COOKIE = "useagent_connect_state";

function rememberConnectState(c: Context<AppEnv>, started: { state: string; expiresAt: string }): void {
  setCookie(c, CONNECT_STATE_COOKIE, started.state, {
    httpOnly: true,
    sameSite: "Lax",
    secure: env.FRONTEND_ORIGIN.startsWith("https:"),
    path: "/api/integrations",
    expires: new Date(started.expiresAt),
  });
}

export function createIntegrationRoutes(deps?: IntegrationServiceDependencies): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const service = createIntegrationService(deps);

  const completePublicCallback: Handler<AppEnv> = async (c) => {
    const provider = c.req.param("provider")?.trim() ?? "";
    const state = c.req.query("state")?.trim();
    const fallback = new URL("/settings?integration=error#integrations", env.FRONTEND_ORIGIN);
    if (!provider || !state || state.length > 256) return c.redirect(fallback.toString(), 303);
    const callback = Object.fromEntries(
      Object.entries(c.req.query()).flatMap(([key, value]) =>
        key !== "state" && key.length <= 64 && value.length <= 4_096 ? [[key, value]] : [],
      ),
    );
    // Only the person who started the flow finishes it: when signed in, the
    // session must be that user (enforced by the claim); without a session, the
    // browser must hold the state cookie set when the flow started.
    const signedInUserId = (await resolveSession(c.req.raw.headers).catch(() => null))?.user.id;
    if (!signedInUserId && !sameSecret(getCookie(c, CONNECT_STATE_COOKIE) ?? "", state)) {
      return c.redirect(fallback.toString(), 303);
    }
    try {
      const completed = await service.completePublicCallback({
        provider,
        state,
        callback,
        ...(signedInUserId ? { actorUserId: signedInUserId } : {}),
      });
      const destination = new URL(completed.returnTo, env.FRONTEND_ORIGIN);
      destination.searchParams.set("integration", "connected");
      destination.searchParams.set("integration_provider", provider);
      return c.redirect(destination.toString(), 303);
    } catch {
      return c.redirect(fallback.toString(), 303);
    }
  };

  // Keep the provider-first callback used by the published Slack app while
  // retaining the original callback-first route for in-flight OAuth sessions.
  routes.get("/:provider/callback", completePublicCallback);
  routes.get("/callback/:provider", completePublicCallback);

  routes.use("*", orgScope);

  routes.get("/", async (c) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "user_required" }, 403);
    return c.json({
      integrations: await service.listIntegrations({ orgId: c.get("orgId"), userId }),
    });
  });

  routes.post("/:provider/connect", async (c) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "user_required" }, 403);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      const result = await service.startConnect({
        orgId: c.get("orgId"),
        userId,
        provider: c.req.param("provider"),
        returnTo: typeof body.returnTo === "string" ? body.returnTo : "/settings#integrations",
        owner: { type: "user", userId },
      });
      rememberConnectState(c, result);
      return c.json(result);
    } catch (error) {
      const message = (error as Error).message;
      return c.json({ error: message }, errorStatus(message));
    }
  });

  routes.post("/:provider/connect/org", orgAdminScope, async (c) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "user_required" }, 403);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    try {
      const result = await service.startConnect({
        orgId: c.get("orgId"),
        userId,
        provider: c.req.param("provider"),
        returnTo: typeof body.returnTo === "string" ? body.returnTo : "/settings#integrations",
        owner: { type: "org" },
      });
      rememberConnectState(c, result);
      return c.json(result);
    } catch (error) {
      const message = (error as Error).message;
      return c.json({ error: message }, errorStatus(message));
    }
  });

  routes.post("/callback", async (c) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "user_required" }, 403);
    let body: Record<string, unknown> = {};
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body.state !== "string" || !body.state) {
      return c.json({ error: "state is required" }, 400);
    }
    const callback = body.callback && typeof body.callback === "object" && !Array.isArray(body.callback)
      ? Object.fromEntries(
          Object.entries(body.callback as Record<string, unknown>).flatMap(([key, value]) =>
            key.length <= 64 && typeof value === "string" && value.length <= 4_096
              ? [[key, value]]
              : [],
          ),
        )
      : undefined;
    try {
      const connection = await service.completeConnect({
        orgId: c.get("orgId"),
        userId,
        state: body.state,
        callback,
      });
      return c.json({ connection });
    } catch (error) {
      const message = (error as Error).message;
      return c.json({ error: message }, errorStatus(message));
    }
  });

  routes.delete("/:provider", async (c) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "user_required" }, 403);
    const connectionId = c.req.query("connectionId");
    if (!connectionId) return c.json({ error: "connectionId is required" }, 400);
    try {
      const connection = await service.disconnect({
        orgId: c.get("orgId"),
        userId,
        connectionId,
        provider: c.req.param("provider"),
      });
      return c.json({ connection });
    } catch (error) {
      const message = (error as Error).message;
      return c.json({ error: message }, errorStatus(message));
    }
  });

  routes.delete("/:provider/org", orgAdminScope, async (c) => {
    const userId = c.get("userId");
    if (!userId) return c.json({ error: "user_required" }, 403);
    const connectionId = c.req.query("connectionId");
    if (!connectionId) return c.json({ error: "connectionId is required" }, 400);
    try {
      const connection = await service.disconnect({
        orgId: c.get("orgId"),
        userId,
        connectionId,
        provider: c.req.param("provider"),
        allowOrgOwner: true,
      });
      return c.json({ connection });
    } catch (error) {
      const message = (error as Error).message;
      return c.json({ error: message }, errorStatus(message));
    }
  });

  return routes;
}

export const integrationRoutes = createIntegrationRoutes();
