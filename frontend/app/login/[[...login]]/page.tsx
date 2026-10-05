import type { Metadata } from "next";
import { safeAuthRedirect } from "@/components/auth/safe-redirect";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = {
  title: "Sign in - useAgent",
  description: "Sign in to your useAgent workspace.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string | string[] }>;
}) {
  const { redirect_url } = await searchParams;
  return (
    <AuthForm
      callbackURL={safeAuthRedirect(typeof redirect_url === "string" ? redirect_url : null)}
    />
  );
}
