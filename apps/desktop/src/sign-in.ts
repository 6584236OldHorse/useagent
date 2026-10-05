import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { BrowserWindow } from "electron";

const random = () => randomBytes(32).toString("base64url");
const encoded = /^[A-Za-z0-9_-]{43}$/;

/** Browser authentication and the local app meet through a single-use PKCE exchange. */
export function createDesktopSignIn(plane: URL, window: BrowserWindow, openExternal: (url: string) => Promise<void>) {
  let pending: { state: string; verifier: string; expires: number } | undefined;
  return {
    async begin(): Promise<void> {
      const verifier = random();
      const state = random();
      pending = { state, verifier, expires: Date.now() + 10 * 60_000 };
      const url = new URL("/desktop-auth", plane);
      url.searchParams.set("state", state);
      url.searchParams.set("challenge", createHash("sha256").update(verifier).digest("base64url"));
      try { await openExternal(url.href); }
      catch { pending = undefined; throw new Error("Could not open the sign-in browser."); }
    },
    async complete(value: string): Promise<void> {
      const url = new URL(value);
      if (url.protocol !== "useagent:" || url.hostname !== "auth" || url.pathname !== "/callback" || url.hash || url.username || url.password) {
        throw new Error("Invalid desktop sign-in callback.");
      }
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code") ?? "";
      if (!pending || Date.now() >= pending.expires || !encoded.test(state) || !encoded.test(code)
        || url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("code").length !== 1
        || !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) {
        throw new Error("Desktop sign-in expired or belongs to another request. Try again.");
      }
      const request = pending;
      pending = undefined;
      const response = await fetch(new URL("/api/auth/desktop/exchange", plane), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, state, verifier: request.verifier }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error("Desktop sign-in could not be verified. Try again.");
      const result = await response.json() as { ticket?: unknown };
      if (typeof result.ticket !== "string" || result.ticket.length > 16_384) throw new Error("Invalid sign-in response.");
      const frame = window.webContents.mainFrame;
      if (new URL(frame.url).origin !== plane.origin) throw new Error("Desktop sign-in page changed. Try again.");
      // The ticket travels only over HTTPS and into the trusted app frame, never in a URL or log.
      await frame.executeJavaScript(`(async () => {
        if (location.origin !== ${JSON.stringify(plane.origin)} || !window.Clerk?.loaded) throw new Error('Sign-in page is not ready');
        const attempt = await window.Clerk.client.signIn.create({strategy:'ticket',ticket:${JSON.stringify(result.ticket)}});
        if (attempt.status !== 'complete') throw new Error('Sign-in did not complete');
        await window.Clerk.setActive({session:attempt.createdSessionId});
        location.replace('/');
      })()`);
      window.show();
      window.focus();
    },
  };
}
