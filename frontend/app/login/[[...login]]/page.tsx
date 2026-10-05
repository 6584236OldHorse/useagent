import type { Metadata } from "next";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = {
  title: "Sign in - useAgent",
  description: "Sign in to your useAgent workspace.",
};

function safeAuthRedirect(value: string | null): string {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  const url = new URL(value, "https://useagent.invalid");
  return `${url.pathname}${url.search}${url.hash}`;
}

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
