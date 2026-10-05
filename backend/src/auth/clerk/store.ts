import { and, eq, isNull, or, sql } from "drizzle-orm";
import { createPersonalOrgForUser } from "../../auth-hooks";
import { db, type DbTx, type Executor } from "../../db/client";
import { member, organization, user } from "../../db/auth-schema";
import { selfSignupEnabled } from "../../env";
import type { IdentityMembership, IdentityOrganization, IdentityProfile } from "./directory";

export class IdentityAccessError extends Error {
  readonly code = "no_organization";
}

/** Only provisioning and webhook reconciliation serialize, not ordinary auth reads. */
export async function withIdentitySync<T>(operation: (tx: DbTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // ponytail: serialize rare identity syncs; use per-identity locks if enrolment throughput requires it.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('identity-sync'))`);
    return operation(tx);
  });
}

export async function findIdentityUser(subject: string, exec: Executor = db) {
  const [row] = await exec.select().from(user).where(eq(user.clerkUserId, subject)).limit(1);
  return row ?? null;
}

export function identityRole(role: string): "owner" | "member" | null {
  if (role === "org:owner" || role === "org:admin" || role === "owner" || role === "admin")
    return "owner";
  return role === "org:member" || role === "member" ? "member" : null;
}

/** Accepted membership in a mapped org is invitation/provisioning proof, not a pending email invite. */
export async function canCreateIdentityUser(
  profile: IdentityProfile,
  memberships: IdentityMembership[],
  tx: Executor,
): Promise<boolean> {
  if (selfSignupEnabled()) return true;
  for (const item of memberships) {
    if (
      item.userId !== profile.id ||
      item.organization.createdBy === profile.id ||
      !identityRole(item.role)
    )
      continue;
    const [row] = await tx
      .select({ id: organization.id })
      .from(organization)
      .where(eq(organization.clerkOrgId, item.organization.id))
      .limit(1);
    if (row) return true;
  }
  return false;
}

/** Preserve the app's user id; a verified email cannot steal another remote binding. */
export async function syncIdentityUser(
  profile: IdentityProfile,
  allowCreate: boolean,
  tx: DbTx,
): Promise<{
  user: typeof user.$inferSelect;
  created: boolean;
}> {
  if (!profile.active) throw new IdentityAccessError();
  const existing = await findIdentityUser(profile.id, tx);
  const changes = {
    name: profile.name,
    image: profile.image,
    updatedAt: new Date(profile.updatedAt),
    ...(profile.email ? { email: profile.email, emailVerified: true } : {}),
  };
  if (existing) {
    if (changes.email) {
      const [conflict] = await tx
        .select({ id: user.id })
        .from(user)
        .where(sql`lower(${user.email}) = lower(${changes.email}) AND ${user.id} <> ${existing.id}`)
        .limit(1);
      // Profile metadata must not prevent authoritative role downgrades or removals.
      if (conflict) {
        delete changes.email;
        delete changes.emailVerified;
      }
    }
    const [updated] = await tx
      .update(user)
      .set(changes)
      .where(eq(user.id, existing.id))
      .returning();
    return { user: updated ?? existing, created: false };
  }
  if (!profile.email) throw new IdentityAccessError();
  const matches = await tx
    .select()
    .from(user)
    .where(sql`lower(${user.email}) = lower(${profile.email})`)
    .limit(2);
  if (matches.length > 1) throw new IdentityAccessError();
  const match = matches[0];
  if (match) {
    if (match.clerkUserId && match.clerkUserId !== profile.id) throw new IdentityAccessError();
    const [linked] = await tx
      .update(user)
      .set({ ...changes, clerkUserId: profile.id })
      .where(
        and(eq(user.id, match.id), or(isNull(user.clerkUserId), eq(user.clerkUserId, profile.id))),
      )
      .returning();
    if (!linked) throw new IdentityAccessError();
    return { user: linked, created: false };
  }
  if (!allowCreate) throw new IdentityAccessError();
  const [created] = await tx
    .insert(user)
    .values({
      id: crypto.randomUUID(),
      clerkUserId: profile.id,
      name: profile.name,
      email: profile.email,
      emailVerified: true,
      image: profile.image,
    })
    .onConflictDoNothing()
    .returning();
  if (!created) return syncIdentityUser(profile, false, tx);
  if (!(await createPersonalOrgForUser(created, tx))) throw new IdentityAccessError();
  return { user: created, created: true };
}

/** Slug matching is reserved for the explicit migration, never a webhook identity claim. */
export async function syncIdentityOrganization(value: IdentityOrganization, tx: DbTx) {
  const [existing] = await tx
    .select()
    .from(organization)
    .where(eq(organization.clerkOrgId, value.id))
    .limit(1);
  if (existing) {
    const [updated] = await tx
      .update(organization)
      .set({ name: value.name, logo: value.image })
      .where(eq(organization.id, existing.id))
      .returning();
    return updated ?? existing;
  }
  if (value.createdBy && !selfSignupEnabled() && !(await findIdentityUser(value.createdBy, tx)))
    throw new IdentityAccessError();
  let localSlug = value.slug;
  for (let suffix = 1; (await tx.select({ id: organization.id }).from(organization).where(eq(organization.slug, localSlug)).limit(1)).length; suffix++) {
    localSlug = `${value.id}-${suffix}`;
  }
  const [created] = await tx
    .insert(organization)
    .values({
      id: `org_${crypto.randomUUID()}`,
      clerkOrgId: value.id,
      name: value.name,
      slug: localSlug,
      logo: value.image,
      createdAt: new Date(value.createdAt),
    })
    .returning();
  if (!created) throw new IdentityAccessError();
  return created;
}

export async function syncIdentityMembership(
  localUserId: string,
  item: IdentityMembership,
  tx: DbTx,
): Promise<void> {
  const [org] = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.clerkOrgId, item.organization.id))
    .limit(1);
  if (!org) return;
  const role = identityRole(item.role);
  if (!role) {
    await tx
      .delete(member)
      .where(and(eq(member.userId, localUserId), eq(member.organizationId, org.id)));
    return;
  }
  await tx
    .insert(member)
    .values({
      id: `member_${crypto.randomUUID()}`,
      userId: localUserId,
      organizationId: org.id,
      role,
      createdAt: new Date(),
    })
    .onConflictDoUpdate({ target: [member.organizationId, member.userId], set: { role } });
}

/** Revocation removes access, not product records or their stable local owners. */
export async function unlinkIdentityUser(subject: string, tx: DbTx): Promise<void> {
  const existing = await findIdentityUser(subject, tx);
  if (!existing) return;
  await tx.delete(member).where(eq(member.userId, existing.id));
  await tx.update(user).set({ clerkUserId: null }).where(eq(user.id, existing.id));
}

export async function unlinkIdentityOrganization(subject: string, tx: DbTx): Promise<void> {
  const [existing] = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.clerkOrgId, subject))
    .limit(1);
  if (!existing) return;
  await tx.delete(member).where(eq(member.organizationId, existing.id));
  await tx.update(organization).set({ clerkOrgId: null }).where(eq(organization.id, existing.id));
}

export async function removeIdentityMembership(
  orgSubject: string,
  userSubject: string,
  tx: DbTx,
): Promise<void> {
  const localUser = await findIdentityUser(userSubject, tx);
  const [org] = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.clerkOrgId, orgSubject))
    .limit(1);
  if (localUser && org)
    await tx
      .delete(member)
      .where(and(eq(member.userId, localUser.id), eq(member.organizationId, org.id)));
}

export async function pruneIdentityMemberships(
  localUserId: string,
  remoteOrgIds: Set<string>,
  tx: DbTx,
): Promise<void> {
  const rows = await tx
    .select({ id: member.id, subject: organization.clerkOrgId })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, localUserId));
  for (const row of rows) {
    if (row.subject && !remoteOrgIds.has(row.subject))
      await tx.delete(member).where(eq(member.id, row.id));
  }
}
