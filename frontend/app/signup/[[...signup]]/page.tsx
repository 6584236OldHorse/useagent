import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthScreen } from "@/components/auth/auth-screen";
import { IdentityForm } from "@/components/auth/identity-form";
import { legacyAuthEnabled } from "@/lib/auth-mode";

export const metadata: Metadata = {
  title: "Sign up - useAgent",
  description: "Create your useAgent workspace account.",
};

export default function SignupPage() {
  if (legacyAuthEnabled) redirect("/login");
  return (
    <AuthScreen>
      <IdentityForm mode="sign-up" />
    </AuthScreen>
  );
}
