import type { Metadata } from "next";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
  title: "Sign up - UseAgent",
  description: "Create your UseAgent workspace account.",
};

export default function SignupPage() {
  redirect("/login");
}
