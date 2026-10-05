import { electronClient } from "@better-auth/electron/client";
import { createAuthClient, type BetterAuthClientPlugin } from "better-auth/client";
import { safeStorage } from "electron";
import { join } from "node:path";
import { authScope, createAuthStorage } from "./auth-storage";
import type { DesktopAuthClient } from "./sign-in";

export function createDesktopAuthClient(plane: URL, userData: string) {
  const scope = authScope(plane.origin);
  const memory = new Map<string, unknown>();
  const storage = process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text"
    ? { getItem: (name: string) => memory.get(name) ?? null, setItem: (name: string, value: unknown) => { memory.set(name, value); } }
    : createAuthStorage(join(userData, `auth-state.${scope}.json`));
  return createAuthClient({
    baseURL: plane.origin,
    plugins: [electronClient({
      signInURL: new URL("/desktop-auth", plane),
      protocol: { scheme: "useagent" },
      callbackPath: "/auth/callback",
      storagePrefix: `better-auth-${scope}`,
      storage,
      userImageProxy: { enabled: false },
      // @better-auth/electron 1.6.25's runtime API is sound, but its BetterFetch generic fails TS2322 here.
    }) as unknown as BetterAuthClientPlugin],
  }) as unknown as DesktopAuthClient;
}
