"use client";

import { SignIn, SignUp } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { DesktopSignIn } from "./desktop-sign-in";

const appearance = {
  variables: {
    colorPrimary: "var(--color-accent-500)",
    colorBackground: "var(--color-background-primary-default)",
    colorForeground: "var(--color-text-primary)",
    colorMutedForeground: "var(--color-text-secondary)",
    colorInputBackground: "var(--color-background-tertiary-default)",
    colorInputText: "var(--color-text-primary)",
    borderRadius: "0.75rem",
    fontFamily: "var(--font-sans)",
  },
  elements: {
    rootBox: "w-full",
    cardBox: "w-full shadow-none",
    card: "w-full border border-border-button-default bg-background-secondary-default shadow-none",
    headerTitle: "text-title-2-medium text-text-primary",
    headerSubtitle: "text-body-regular text-text-secondary",
    formButtonPrimary: "rounded-full",
    footerActionLink: "text-text-accent",
  },
} as const;

export function IdentityForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const [desktop, setDesktop] = useState<
    { openExternal: (url: string) => void } | null | undefined
  >();
  useEffect(
    () =>
      setDesktop(
        (window as Window & { useagentDesktop?: { openExternal: (url: string) => void } })
          .useagentDesktop ?? null,
      ),
    [],
  );
  if (desktop === undefined)
    return (
      <p role="status" className="text-body-regular text-text-secondary">
        Loading sign-in...
      </p>
    );
  if (desktop) return <DesktopSignIn openExternal={desktop.openExternal} />;
  return mode === "sign-in" ? (
    <SignIn
      appearance={appearance}
      fallbackRedirectUrl="/"
      path="/login"
      routing="path"
      signUpUrl="/signup"
    />
  ) : (
    <SignUp
      appearance={appearance}
      fallbackRedirectUrl="/"
      path="/signup"
      routing="path"
      signInUrl="/login"
    />
  );
}
