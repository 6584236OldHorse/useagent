import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Sign up - useAgent",
  description: "Create your useAgent workspace account.",
};

/** One card serves both; a closed deployment shows sign-in whatever the mode. */
export default function SignupPage() {
  redirect("/login?mode=signup");
}
