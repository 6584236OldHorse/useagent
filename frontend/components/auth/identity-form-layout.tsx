import type { ReactNode } from "react";

export type IdentityMode = "sign-in" | "sign-up";

export const IDENTITY_COPY = {
  "sign-in": {
    title: "Welcome back",
    subtitle: "Enter your credentials to continue",
    submit: "Sign in",
    pending: "Signing in…",
  },
  "sign-up": {
    title: "Create your account",
    subtitle: "Get started with useAgent",
    submit: "Create account",
    pending: "Creating account…",
  },
} as const;

export function IdentityFormShell({
  mode,
  error,
  children,
}: {
  mode: IdentityMode;
  error: string | null;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[360px]">
      <h1 className="text-title-2-medium text-text-primary">{IDENTITY_COPY[mode].title}</h1>
      <p className="mt-1.5 text-body-regular text-text-secondary">{IDENTITY_COPY[mode].subtitle}</p>
      {children}
      {error && (
        <p role="alert" className="mt-4 text-body-2-regular text-text-error-primary">
          {error}
        </p>
      )}
    </div>
  );
}

export function IdentityStatus({
  title,
  message,
  error = false,
}: {
  title: string;
  message: string;
  error?: boolean;
}) {
  return (
    <div className="mx-auto w-full max-w-[360px]">
      <h1 className="text-title-2-medium text-text-primary">{title}</h1>
      <p
        className={`mt-2 text-body-regular ${error ? "text-text-error-primary" : "text-text-secondary"}`}
      >
        {message}
      </p>
      <div id="clerk-captcha" />
    </div>
  );
}
