import type { Metadata } from "next";
import { AuthScreen } from "@/components/auth/auth-screen";
import { IdentityForm } from "@/components/auth/identity-form";
import { legacyAuthEnabled } from "@/lib/auth-mode";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = {
  title: "Sign in - useAgent",
  description: "Sign in to your useAgent workspace.",
};

export default function LoginPage() {
  if (legacyAuthEnabled) return <AuthForm />;
  return (
    <AuthScreen>
      <IdentityForm mode="sign-in" />
    </AuthScreen>
  );
}
