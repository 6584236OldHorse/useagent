import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { CookieJar, createOrgSession, fetchApi, json, ORIGIN } from "./helpers";

test("Electron PKCE handoff creates a separate revocable session and rejects replay", async () => {
  const browser = await createOrgSession("desktop-handoff");
  const browserSession = await json("/api/auth/get-session", { cookies: browser.cookies });
  const verifier = randomBytes(32).toString("base64url");
  const state = "desktoprequest01";
  const query = new URLSearchParams({
    client_id: "electron",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const transferPath = `/api/auth/electron/transfer-user?${query}`;
  expect((await fetchApi(transferPath, { method: "POST", body: {} })).status).toBe(401);

  const transferred = await json(transferPath, {
    method: "POST", cookies: browser.cookies, body: {},
  });
  expect(transferred.status).toBe(200);
  const body = { token: transferred.body.electron_authorization_code, state, code_verifier: verifier };
  // Renderer JavaScript carries the web origin; only the native main process reaches the exchange.
  expect((await fetchApi("/api/auth/electron/token", { method: "POST", body })).status).toBe(403);
  expect((await fetchApi("/api/auth/electron/token", {
    method: "POST", body, headers: { origin: ORIGIN, "electron-origin": "useagent:/" },
  })).status).toBe(403);
  const exchange = { method: "POST", headers: { origin: "useagent:/" }, body };
  const response = await fetchApi("/api/auth/electron/token", exchange);
  expect(response.status).toBe(200);
  const desktop = new CookieJar();
  desktop.absorb(response);
  const identity = await response.json();
  expect(identity.user.id).toBe(browserSession.body.user.id);
  expect(typeof identity.token).toBe("string");
  expect(browser.cookies).not.toContain(identity.token);
  expect((await fetchApi("/api/auth/electron/token", exchange)).status).toBe(404);

  // The SDK transfers identity, not the browser's workspace. Main must select
  // one through the membership-checked API before loading the hosted product.
  const memberships = await json("/api/auth/organization/list", { cookies: desktop.header() });
  expect(memberships.body).toHaveLength(2);
  expect((await json("/api/auth/get-session", { cookies: desktop.header() })).body.session.activeOrganizationId)
    .toBeNull();
  expect((await fetchApi("/api/auth/organization/set-active", {
    method: "POST", cookies: desktop.header(), body: { organizationId: browser.orgId },
  })).status).toBe(200);
  const desktopSession = await json("/api/auth/get-session", { cookies: desktop.header() });
  expect(desktopSession.body.user.id).toBe(browserSession.body.user.id);
  expect(desktopSession.body.session.activeOrganizationId).toBe(browser.orgId);
  expect((await fetchApi("/api/auth/sign-out", {
    method: "POST", cookies: desktop.header(), body: {},
  })).status).toBe(200);
  expect((await json("/api/auth/get-session", { cookies: desktop.header() })).body).toBeNull();
  expect((await json("/api/auth/get-session", { cookies: browser.cookies })).body.session.id)
    .toBe(browserSession.body.session.id);
});
