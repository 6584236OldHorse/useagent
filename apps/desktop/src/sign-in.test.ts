import { expect, test } from "bun:test";
import type { BrowserWindow } from "electron";
import { createDesktopSignIn } from "./sign-in";

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
  const client = {
    async requestAuth() { requested++; },
    async authenticate({ token }: { token: string }) { tokens.push(token); return { error: null }; },
    getCookie: () => "__Secure-better-auth.session_token=app-session; unrelated=value",
    async getSession() { return { data: { session: { activeOrganizationId: null } }, error: null }; },
    organization: {
      async list() { return { data: [{ id: "org-one", name: "One" }], error: null }; },
      async setActive({ organizationId }: { organizationId: string }) { activated.push(organizationId); return { error: null }; },
    },
  };
  const login = createDesktopSignIn(new URL("https://plane.example"), window, client, async () => undefined);
  expect(await login.restore()).toBe(true);
  expect(set).toHaveLength(1);
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
  const window = {
    webContents: { session: { cookies: { set: async (cookie: unknown) => { set.push(cookie); } } } },
    loadURL: async (url: string) => { loaded.push(url); }, show() {}, focus() {},
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

  choose("org-two");
  await completing;
  expect(activated).toEqual(["org-two"]);
  expect(set).toHaveLength(1);
  expect(loaded).toEqual(["https://plane.example/"]);
});
