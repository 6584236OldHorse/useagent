import type { Metadata } from "next";
import { safeAuthRedirect } from "@/components/auth/safe-redirect";
import { verificationNotice } from "@/components/auth/verification-notice";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = {
  title: "Sign in - useAgent",
  description: "Sign in to your useAgent workspace.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    redirect_url?: string | string[];
    mode?: string | string[];
    verified?: string | string[];
    error?: string | string[];
  }>;
}) {
  const { redirect_url, mode, verified, error } = await searchParams;
  return (
    <AuthForm
      callbackURL={safeAuthRedirect(typeof redirect_url === "string" ? redirect_url : null)}
      initialMode={mode === "signup" ? "signup" : "signin"}
      notice={verificationNotice({ verified, error })}
    />
  );
}
