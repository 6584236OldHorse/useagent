import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Sign up - useAgent",
  description: "Create your useAgent workspace account.",
};

export default function SignupPage() {
  redirect("/login");
}
