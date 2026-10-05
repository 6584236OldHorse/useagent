import { expect, test } from "bun:test";
import type { BrowserWindow } from "electron";
import { createDesktopSignIn, desktopOrganizationLabel } from "./sign-in";

test("browser sign-in uses the official exchange, writes only to the app session, and rejects invalid callbacks", async () => {
  const set: unknown[] = [];
  const loaded: string[] = [];
  const window = {
    webContents: { session: { cookies: { set: async (cookie: unknown) => { set.push(cookie); } } } },
    loadURL: async (url: string) => { loaded.push(url); }, show() {}, focus() {},
  } as unknown as BrowserWindow;
  let requested = 0;
  const tokens: string[] = [];
  const activated: string[] = [];
  let activeOrganizationId: string | null = "org-one";
  const client = {
    async requestAuth() { requested++; },
    async authenticate({ token }: { token: string }) { tokens.push(token); activeOrganizationId = null; return { error: null }; },
    getCookie: () => "__Secure-better-auth.session_token=app-session; unrelated=value",
    async getSession() { return { data: { session: { activeOrganizationId } }, error: null }; },
    organization: {
      async list() { return { data: [{ id: "org-one", name: "One" }], error: null }; },
      async setActive({ organizationId }: { organizationId: string }) { activated.push(organizationId); activeOrganizationId = organizationId; return { error: null }; },
    },
  };
  const login = createDesktopSignIn(new URL("https://plane.example"), window, client, async () => undefined);
  expect(await login.restore()).toBe(true);
  expect(set).toHaveLength(1);
  expect(activated).toEqual([]);
  set.length = 0;
  await login.begin();
  await expect(login.complete("not-a-url")).rejects.toThrow("Invalid");
  await expect(login.complete("useagent://auth:123/callback#token=valid")).rejects.toThrow("Invalid");
  await expect(login.complete("useagent://auth/callback#token=valid&token=replay")).rejects.toThrow("Invalid");
  expect(tokens).toEqual([]);

  await login.complete("useagent://auth/callback#token=official_token");
  expect(requested).toBe(1);
  expect(tokens).toEqual(["official_token"]);
  expect(activated).toEqual(["org-one"]);
  expect(set).toEqual([{ url: "https://plane.example/", name: "__Secure-better-auth.session_token", value: "app-session", path: "/", httpOnly: true, secure: true, sameSite: "lax" }]);
  expect(loaded).toEqual(["https://plane.example/"]);
});

test("two-workspace sign-in cannot load the hosted app until a member workspace is chosen", async () => {
  const set: unknown[] = [];
  const loaded: string[] = [];
  let shown = 0;
  const window = {
    webContents: { session: { cookies: { set: async (cookie: unknown) => { set.push(cookie); } } } },
    loadURL: async (url: string) => { loaded.push(url); }, show() { shown++; }, focus() {},
  } as unknown as BrowserWindow;
  const activated: string[] = [];
  let choose!: (organizationId: string) => void;
  let chooserStarted = false;
  const choice = new Promise<string>(resolve => { choose = resolve; });
  const client = {
    async requestAuth() {},
    async authenticate() { return { error: null }; },
    getCookie: () => "better-auth.session_token=app-session",
    async getSession() { return { data: { session: { activeOrganizationId: null } }, error: null }; },
    organization: {
      async list() { return { data: [{ id: "org-one", name: "One" }, { id: "org-two", name: "Two" }], error: null }; },
      async setActive({ organizationId }: { organizationId: string }) { activated.push(organizationId); return { error: null }; },
    },
  };
  const login = createDesktopSignIn(new URL("https://plane.example"), window, client, async () => {
    chooserStarted = true;
    return choice;
  });

  const completing = login.complete("useagent://auth/callback#token=official_token");
  while (!chooserStarted) await Promise.resolve();
  expect(set).toEqual([]);
  expect(loaded).toEqual([]);
  expect(shown).toBe(0);

  choose("org-two");
  await completing;
  expect(activated).toEqual(["org-two"]);
  expect(set).toHaveLength(1);
  expect(loaded).toEqual(["https://plane.example/"]);
  expect(shown).toBe(1);
});

test("a revoked stored session returns to login without copying stale cookies", async () => {
  const set: unknown[] = [];
  let listed = 0;
  const window = {
    webContents: { session: { cookies: { set: async (cookie: unknown) => { set.push(cookie); } } } },
  } as unknown as BrowserWindow;
  const client = {
    async requestAuth() {},
    async authenticate() { return { error: null }; },
    getCookie: () => "better-auth.session_token=revoked-session",
    async getSession() { return { data: null, error: null }; },
    organization: {
      async list() { listed++; return { data: [], error: null }; },
      async setActive() { return { error: null }; },
    },
  };
  const login = createDesktopSignIn(new URL("https://plane.example"), window, client, async () => undefined);

  expect(await login.restore()).toBe(false);
  expect(listed).toBe(0);
  expect(set).toEqual([]);
});

test("duplicate workspace names remain distinguishable in the native choice", () => {
  expect([
    desktopOrganizationLabel({ id: "org-one", name: "Acme" }),
    desktopOrganizationLabel({ id: "org-two", name: "Acme" }),
  ]).toEqual(["Acme (org-one)", "Acme (org-two)"]);
});
