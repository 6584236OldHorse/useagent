import { Hono } from "hono";
import { auth } from "../auth";
import { invitationMailEnabled } from "../auth-invitations";
import { allowDevOrg, googleAuthEnabled } from "../env";
import type { AppEnv } from "../http";

/** Session reads are renderer-reachable (the desktop copies the HttpOnly
 *  cookie into Chromium), so every token-like field leaves the JSON here. */
function withoutTokens(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTokens);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).filter(([key]) => !/token/i.test(key)).map(([key, item]) => [key, withoutTokens(item)]),
    );
  }
  return value;
}

async function redactSessionTokens(response: Response): Promise<Response> {
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(withoutTokens(await response.json())), { status: response.status, headers });
}

const routes = new Hono<AppEnv>();
routes.get("/api/auth/provider-config", (c) =>
  c.json({
    google: googleAuthEnabled(),
    emailPassword: true,
    allowDevOrg: allowDevOrg(),
    invitationEmail: invitationMailEnabled(),
  }),
);
routes.on("GET", ["/api/auth/get-session", "/api/auth/list-sessions"], async (c) =>
  redactSessionTokens(await auth.handler(c.req.raw)),
);
/** Only the native main process may exchange an authorization code for a
 *  session token. Browsers always send their web Origin on a POST and cannot
 *  forge it, so a renderer holding the copied cookie never reaches the exchange. */
routes.post("/api/auth/electron/token", (c) => {
  const origin = c.req.header("origin") ?? c.req.header("electron-origin");
  if (origin !== "useagent:/") return c.json({ message: "Desktop token exchange requires the native app." }, 403);
  return auth.handler(c.req.raw);
});
/** An invitation id must come from the invitation itself (the mail or the
 *  inviter), never from a lookup by the session's email claim: a Google account
 *  can keep a verified claim on an address after the mailbox changed hands. */
routes.on(["GET", "POST"], "/api/auth/organization/list-user-invitations", (c) =>
  c.json({ message: "Not available" }, 404),
);
routes.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

export function handleAuthRequest(request: Request): Response | Promise<Response> {
  return routes.fetch(request);
}
