import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthScreen } from "@/components/auth/auth-screen";
import { IdentityForm } from "@/components/auth/identity-form";
import { legacyAuthEnabled } from "@/lib/auth-mode";

export const metadata: Metadata = {
  title: "Sign up - useAgent",
  description: "Create your useAgent workspace account.",
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ redirect_url?: string | string[] }>;
}) {
  if (legacyAuthEnabled) redirect("/login");
  const { redirect_url } = await searchParams;
  return (
    <AuthScreen>
      <IdentityForm
        mode="sign-up"
        redirectTo={typeof redirect_url === "string" ? redirect_url : "/"}
      />
    </AuthScreen>
  );
}
