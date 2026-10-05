import { auth } from "../auth";
import { resolveClerkSession } from "./clerk/resolver";
export { IdentityAccessError } from "./clerk/store";

export interface IdentitySession {
  user: { id: string; name: string; email: string; image: string | null };
  session: { activeOrganizationId?: string | null };
}

/** One-release escape hatch; unset or unknown values use the managed identity. */
export function authProvider(): "clerk" | "better-auth" {
  return process.env.AUTH === "better-auth" ? "better-auth" : "clerk";
}

export async function resolveSession(headers: Headers): Promise<IdentitySession | null> {
  if (authProvider() === "better-auth") {
    const session = await auth.api.getSession({ headers });
    return session
      ? { ...session, user: { ...session.user, image: session.user.image ?? null } }
      : null;
  }
  return resolveClerkSession(headers);
}
