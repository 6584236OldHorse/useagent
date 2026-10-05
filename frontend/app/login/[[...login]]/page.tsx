import type { Metadata } from "next";
import { AuthScreen } from "@/components/auth/auth-screen";
import { IdentityForm } from "@/components/auth/identity-form";
import { legacyAuthEnabled } from "@/lib/auth-mode";
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
  if (legacyAuthEnabled) return <AuthForm />;
  const { redirect_url } = await searchParams;
  return (
    <AuthScreen>
      <IdentityForm
        mode="sign-in"
        redirectTo={typeof redirect_url === "string" ? redirect_url : "/"}
      />
    </AuthScreen>
  );
}
