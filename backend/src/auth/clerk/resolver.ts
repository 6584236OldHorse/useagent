import { verifyToken } from "@clerk/backend";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { organization } from "../../db/auth-schema";
import { betterAuthTrustedOrigins } from "../../env";
import type { IdentitySession } from "../session";
import { identityDirectory, identityNotFound, type IdentityDirectory } from "./directory";
import {
  canCreateIdentityUser,
  findIdentityUser,
  IdentityAccessError,
  syncIdentityMembership,
  syncIdentityUser,
  withIdentitySync,
} from "./store";

export function sessionToken(headers: Headers): string | null {
  const bearer = /^Bearer\s+(\S+)$/i.exec(headers.get("authorization")?.trim() ?? "")?.[1];
  if (bearer) return bearer.startsWith("uak_") ? null : bearer;
  const cookie = headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("__session="));
  if (!cookie) return null;
  try {
    return decodeURIComponent(cookie.slice("__session=".length)) || null;
  } catch {
    return null;
  }
}

interface SessionOptions {
  jwtKey?: string;
  secretKey?: string;
  authorizedParties?: string[];
  directory?: IdentityDirectory;
}

export async function resolveClerkSession(
  headers: Headers,
  options: SessionOptions = {},
): Promise<IdentitySession | null> {
  const token = sessionToken(headers);
  if (!token) return null;
  let claims: Awaited<ReturnType<typeof verifyToken>>;
  try {
    const jwtKey = options.jwtKey ?? process.env.CLERK_JWT_KEY;
    const secretKey = options.secretKey ?? process.env.CLERK_SECRET_KEY;
    if (!jwtKey && !secretKey) return null;
    claims = await verifyToken(token, {
      jwtKey,
      secretKey,
      authorizedParties: options.authorizedParties ?? betterAuthTrustedOrigins(),
    });
  } catch {
    return null;
  }
  if (!claims.sub || !claims.sid || (claims.sts && claims.sts !== "active")) return null;
  const directory = options.directory ?? identityDirectory;
  let local = await findIdentityUser(claims.sub);
  if (!local) {
    local = await withIdentitySync(async (tx) => {
      const raced = await findIdentityUser(claims.sub, tx);
      if (raced) return raced;
      let profile: Awaited<ReturnType<IdentityDirectory["user"]>>;
      try {
        profile = await directory.user(claims.sub);
      } catch (error) {
        if (identityNotFound(error)) throw new IdentityAccessError();
        throw error;
      }
      if (profile.id !== claims.sub) throw new IdentityAccessError();
      const memberships = await directory.memberships(claims.sub);
      const result = await syncIdentityUser(
        profile,
        await canCreateIdentityUser(profile, memberships, tx),
        tx,
      );
      if (result.created) {
        for (const item of memberships) {
          if (item.userId !== claims.sub) throw new IdentityAccessError();
          await syncIdentityMembership(result.user.id, item, tx);
        }
      }
      return result.user;
    });
  }
  // org_id is the legacy/custom claim; current Clerk session v2 uses o.id.
  const legacyOrg = claims.org_id;
  let currentOrg: unknown;
  if (claims.o !== undefined) {
    if (!claims.o || typeof claims.o !== "object" || Array.isArray(claims.o) || !("id" in claims.o))
      throw new IdentityAccessError();
    currentOrg = claims.o.id;
    if (typeof currentOrg !== "string" || !currentOrg) throw new IdentityAccessError();
  }
  if (legacyOrg && currentOrg && legacyOrg !== currentOrg) throw new IdentityAccessError();
  const subject = legacyOrg ?? currentOrg;
  let activeOrganizationId: string | null = null;
  if (subject) {
    if (typeof subject !== "string") throw new IdentityAccessError();
    const [mapped] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.clerkOrgId, subject))
      .limit(1);
    if (!mapped) throw new IdentityAccessError();
    activeOrganizationId = mapped.id;
  }
  return {
    user: { id: local.id, name: local.name, email: local.email, image: local.image },
    session: { activeOrganizationId },
  };
}
