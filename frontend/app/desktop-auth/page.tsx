"use client";

import { useEffect, useRef, useState } from "react";
import { AuthForm } from "@/app/login/auth-form";
import { AuthScreen } from "@/components/auth/auth-screen";
import { Button } from "@/components/base/buttons/button";
import { useSession } from "@/lib/auth";
import { desktopAuthClient } from "@/lib/desktop-auth-client";

type DesktopAuthRequest = {
  query: Record<string, string>;
  url: string;
};

export function desktopAuthRequest(value: string): DesktopAuthRequest | null {
  const url = new URL(value);
  const query = Object.fromEntries(url.searchParams);
  if (url.hash || url.searchParams.size !== 4
    || url.searchParams.getAll("client_id").length !== 1 || query.client_id !== "electron"
    || url.searchParams.getAll("state").length !== 1 || !/^[A-Za-z0-9]{16}$/.test(query.state ?? "")
    || url.searchParams.getAll("code_challenge").length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge ?? "")
    || url.searchParams.getAll("code_challenge_method").length !== 1 || query.code_challenge_method !== "S256") return null;
  return { query, url: `${url.pathname}${url.search}` };
}

/** OAuth must land back on this page, which is the only one polling for the desktop redirect. */
export async function startDesktopGoogleSignIn(
  request: DesktopAuthRequest,
  social: (input: { provider: "google"; callbackURL: string; fetchOptions: { query: Record<string, string> } }) => Promise<{ error: unknown }>
    = (input) => desktopAuthClient.signIn.social(input),
): Promise<void> {
  const result = await social({ provider: "google", callbackURL: request.url, fetchOptions: { query: request.query } });
  if (result.error) throw new Error("Could not start Google sign-in.");
}

export function restartElectronRedirect(
  previous: ReturnType<typeof setInterval> | null,
  start: () => ReturnType<typeof setInterval> = () => desktopAuthClient.ensureElectronRedirect(),
  stop: (timer: ReturnType<typeof setInterval>) => void = clearInterval,
): ReturnType<typeof setInterval> {
  if (previous) stop(previous);
  return start();
}

export default function DesktopAuthPage() {
  const { session, loading } = useSession();
  const [request, setRequest] = useState<DesktopAuthRequest | null>();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const redirectTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { setRequest(desktopAuthRequest(window.location.href)); }, []);
  useEffect(() => {
    if (!request) return;
    redirectTimer.current = restartElectronRedirect(redirectTimer.current);
    return () => {
      if (redirectTimer.current) clearInterval(redirectTimer.current);
      redirectTimer.current = null;
    };
  }, [request]);

  async function connect() {
    if (!request || pending) return;
    setPending(true);
    setError(null);
    try {
      redirectTimer.current = restartElectronRedirect(redirectTimer.current);
      const result = await desktopAuthClient.electron.transferUser({ fetchOptions: { query: request.query } });
      if (!result.error && result.data?.electron_authorization_code) return;
    } catch {
      // The same actionable message covers network and rejected transfer failures.
    }
    setError("Could not connect the desktop. Start sign-in again.");
    setPending(false);
  }

  if (!request) return (
    <AuthScreen>
      <p role={request === null ? "alert" : "status"}>
        {request === null ? "Open sign-in from the desktop app to begin." : "Loading sign-in..."}
      </p>
    </AuthScreen>
  );
  if (!loading && !session) return (
    <AuthForm callbackURL={request.url} googleAction={() => startDesktopGoogleSignIn(request)} />
  );
  return (
    <AuthScreen>
      <section className="space-y-5">
        <h1 className="text-display-sm text-text-primary">Connect your desktop</h1>
        <p className="text-body-regular text-text-secondary">
          {loading ? "Checking your session..." : `Signed in as ${session?.user.email ?? "your account"}. Approve only if you started this request in your useAgent desktop app.`}
        </p>
        <Button className="rounded-full" disabled={loading || pending} onClick={() => void connect()}>
          {pending ? "Opening useAgent..." : "Connect desktop"}
        </Button>
        {error ? <p role="alert" className="text-body-2-regular text-text-secondary">{error}</p> : null}
      </section>
    </AuthScreen>
  );
}
