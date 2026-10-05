import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { BrowserWindow } from "electron";

const opened: string[] = [];
import { createDesktopSignIn } from "./sign-in";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; opened.length = 0; });

test("browser sign-in binds one callback to PKCE, injects only into the trusted frame, and rejects replay", async () => {
  const scripts: string[] = [];
  const window = { webContents: { mainFrame: { url: "https://plane.example/login", executeJavaScript: async (source: string) => scripts.push(source) } }, show() {}, focus() {} } as unknown as BrowserWindow;
  const login = createDesktopSignIn(new URL("https://plane.example"), window, async url => { opened.push(url); });
  await login.begin();
  const start = new URL(opened[0]!);
  expect(start.origin).toBe("https://plane.example");
  expect(start.pathname).toBe("/desktop-auth");
  const state = start.searchParams.get("state")!;
  const challenge = start.searchParams.get("challenge")!;
  let exchanges = 0;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    exchanges++;
    expect(String(url)).toBe("https://plane.example/api/auth/desktop/exchange");
    const body = JSON.parse(init?.body as string);
    expect(body.state).toBe(state);
    expect(createHash("sha256").update(body.verifier).digest("base64url")).toBe(challenge);
    expect(start.href).not.toContain(body.verifier);
    return Response.json({ ticket: "one-use-fixture-ticket" });
  }) as typeof fetch;
  const code = "B".repeat(43);
  await expect(login.complete(`useagent://auth/callback?state=${"A".repeat(43)}&code=${code}`)).rejects.toThrow("another request");
  expect(exchanges).toBe(0);
  const callback = `useagent://auth/callback?state=${state}&code=${code}`;
  await login.complete(callback);
  expect(exchanges).toBe(1);
  expect(scripts[0]).toContain("one-use-fixture-ticket");
  expect(callback).not.toContain("one-use-fixture-ticket");
  await expect(login.complete(callback)).rejects.toThrow("another request");
  expect(exchanges).toBe(1);
});
