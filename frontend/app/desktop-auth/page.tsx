"use client";

import { SignIn, useAuth, useUser } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { AuthScreen } from "@/components/auth/auth-screen";
import { Button } from "@/components/base/buttons/button";
import { legacyAuthEnabled } from "@/lib/auth-mode";

export default function DesktopAuthPage() {
  return legacyAuthEnabled ? (
    <AuthScreen>
      <p>Browser-to-desktop sign-in is unavailable with the legacy provider.</p>
    </AuthScreen>
  ) : (
    <ManagedDesktopAuthPage />
  );
}

function ManagedDesktopAuthPage() {
  const { isLoaded, userId } = useAuth();
  const { user } = useUser();
  const [request, setRequest] = useState<{
    state: string;
    challenge: string;
    url: string;
  } | null>();
  const [error, setError] = useState<string | null>(null);
  const [handoffUrl, setHandoffUrl] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const url = new URL(window.location.href);
    const state = url.searchParams.get("state") ?? "";
    const challenge = url.searchParams.get("challenge") ?? "";
    setRequest(
      /^[A-Za-z0-9_-]{43}$/.test(state) && /^[A-Za-z0-9_-]{43}$/.test(challenge)
        ? { state, challenge, url: url.href }
        : null,
    );
  }, []);
  async function connect() {
    if (!request) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/desktop/complete", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: request.state, challenge: request.challenge }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 403
            ? "Your account does not have access to a workspace."
            : "Could not connect the desktop. Start sign-in again.",
        );
      const value = (await response.json()) as { url?: string };
      if (!value.url?.startsWith("useagent://auth/callback?"))
        throw new Error("Invalid desktop response.");
      setHandoffUrl(value.url);
      window.location.assign(value.url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect the desktop.");
    } finally {
      setPending(false);
    }
  }
  return (
    <AuthScreen>
      {!isLoaded || request === undefined ? (
        <p role="status">Loading sign-in...</p>
      ) : !request ? (
        <p role="alert">Open sign-in from the desktop app to begin.</p>
      ) : !userId ? (
        <SignIn routing="hash" fallbackRedirectUrl={request.url} />
      ) : (
        <section className="space-y-5">
          <h1 className="text-display-sm text-text-primary">Connect your desktop</h1>
          <p className="text-body-regular text-text-secondary">
            Signed in as{" "}
            {user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? "your account"}. Approve
            only if you started this request in your UseAgent desktop app.
          </p>
          <Button
            className="rounded-full"
            disabled={pending}
            onClick={() => (handoffUrl ? window.location.assign(handoffUrl) : void connect())}
          >
            {pending ? "Connecting..." : handoffUrl ? "Open UseAgent" : "Connect desktop"}
          </Button>
          {handoffUrl ? (
            <p role="status" className="text-body-2-regular text-text-secondary">
              Approve your browser’s request to open UseAgent. If no prompt appears, select Open
              UseAgent above. If this request expires, start sign-in again from the desktop app.
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-body-2-regular text-text-secondary">
              {error}
            </p>
          ) : null}
        </section>
      )}
    </AuthScreen>
  );
}
