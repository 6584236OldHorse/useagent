import { electronProxyClient } from "@better-auth/electron/proxy";
import { createAuthClient } from "better-auth/client";

export const desktopAuthClient = createAuthClient({
  plugins: [electronProxyClient({
    protocol: { scheme: "useagent" },
    callbackPath: "/auth/callback",
  })],
});
