import { auth } from "../auth";

export interface IdentitySession {
  user: { id: string; name: string; email: string; image: string | null };
  session: { activeOrganizationId?: string | null };
}

export async function resolveSession(headers: Headers): Promise<IdentitySession | null> {
  const session = await auth.api.getSession({ headers });
  return session
    ? { ...session, user: { ...session.user, image: session.user.image ?? null } }
    : null;
}
