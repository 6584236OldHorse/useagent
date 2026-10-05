"use client";

import { RiLockLine, RiMailLine } from "@remixicon/react";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { AuthScreen } from "@/components/auth/auth-screen";
import { DesktopSignIn } from "@/components/auth/desktop-sign-in";
import { GoogleSignInButton } from "@/components/auth/google-sign-in-button";
import { Button } from "@/components/base/buttons/button";
import { Divider } from "@/components/base/divider/divider";
import { Input } from "@/components/base/input/input";
import { invalidateSession, useAuthConfig } from "@/lib/auth";
import { backendFetch } from "@/lib/backend-fetch";
import { desktopBridge, type DesktopBridge } from "@/lib/desktop-bridge";

const COPY = {
  title: "Welcome back",
  subtitle: "Enter your credentials to continue",
  submit: "Sign in",
  pending: "Signing in…",
  endpoint: "/api/auth/sign-in/email",
} as const;

export function AuthForm({
  callbackURL = "/",
  googleAction,
  initialDesktopBridge,
}: {
  callbackURL?: string;
  googleAction?: () => Promise<void>;
  initialDesktopBridge?: DesktopBridge | null;
}) {
  const router = useRouter();
  const authConfig = useAuthConfig();
  const [desktop, setDesktop] = useState<DesktopBridge | null | undefined>(initialDesktopBridge);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (initialDesktopBridge === undefined) setDesktop(desktopBridge());
  }, [initialDesktopBridge]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);

    try {
      const res = await backendFetch(COPY.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        setError(data?.message ?? "Something went wrong. Please try again.");
        return;
      }

      invalidateSession();
      router.push(callbackURL);
      router.refresh();
    } catch {
      // Network failure / backend down — keep the page usable, surface inline.
      setError("Couldn't reach the server. Please try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  if (desktop === undefined) return <AuthScreen><p role="status">Loading sign-in...</p></AuthScreen>;
  if (desktop) return <AuthScreen><DesktopSignIn openExternal={desktop.openExternal} /></AuthScreen>;
  return (
    <AuthScreen>
      <div className="mx-auto w-full max-w-[360px]">
        <h1 className="text-title-2-medium text-text-primary">{COPY.title}</h1>
        <p className="mt-1.5 text-body-regular text-text-secondary">{COPY.subtitle}</p>

        {authConfig?.google && (
          <div className="mt-8">
            <GoogleSignInButton enabled callbackURL={callbackURL} action={googleAction} />
          </div>
        )}

        {authConfig?.google && authConfig.emailPassword && (
          <Divider
            aria-hidden
            className="my-6"
            contentClassName="text-mono-label text-text-tertiary"
          >
            or
          </Divider>
        )}

        {authConfig?.emailPassword && (
          <form
            className={`flex flex-col gap-4 ${authConfig.google ? "" : "mt-8"}`}
            onSubmit={handleSubmit}
            noValidate
          >
            <Input
              name="email"
              type="email"
              label="Email"
              placeholder="you@company.com"
              autoComplete="email"
              leadingIcon={RiMailLine}
              value={email}
              onChange={setEmail}
              isRequired
            />
            <Input
              name="password"
              type="password"
              label="Password"
              placeholder="••••••••"
              autoComplete="current-password"
              leadingIcon={RiLockLine}
              value={password}
              onChange={setPassword}
              isRequired
            />

            {error && (
              <p role="alert" className="text-body-2-regular text-text-error-primary">
                {error}
              </p>
            )}

            <Button type="submit" className="mt-2 w-full" disabled={pending}>
              {pending ? COPY.pending : COPY.submit}
            </Button>
          </form>
        )}

        {authConfig && !authConfig.google && !authConfig.emailPassword && (
          <p role="alert" className="mt-8 text-body-2-regular text-text-error-primary">
            Sign-in is unavailable on this server.
          </p>
        )}
      </div>
    </AuthScreen>
  );
}
