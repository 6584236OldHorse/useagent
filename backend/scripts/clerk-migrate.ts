import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { identityClient } from "../src/auth/clerk/client";
import { identityNotFound } from "../src/auth/clerk/directory";
import { identityRole, withIdentitySync } from "../src/auth/clerk/store";
import { client, type DbTx } from "../src/db/client";
import { invitation, member, organization, user } from "../src/db/auth-schema";

type Client = ReturnType<typeof identityClient>;
export interface MigrationClient {
  instance: Pick<Client["instance"], "getOrganizationSettings">;
  users: Pick<Client["users"], "getUser" | "getUserList" | "createUser">;
  organizations: Pick<
    Client["organizations"],
    | "getOrganization"
    | "createOrganization"
    | "getOrganizationMembershipList"
    | "createOrganizationMembership"
  >;
}

type RemoteUser = Awaited<ReturnType<Client["users"]["getUser"]>>;
type RemoteOrganization = Awaited<ReturnType<Client["organizations"]["getOrganization"]>>;

function checkUserReuse(local: typeof user.$inferSelect, remote: RemoteUser): void {
  if (local.clerkUserId) {
    if (remote.id !== local.clerkUserId) throw new Error("Identity migration conflict");
    return;
  }
  const primary = remote.emailAddresses.find(
    (address) => address.id === remote.primaryEmailAddressId,
  );
  if (
    primary?.verification?.status !== "verified" ||
    primary.emailAddress.toLowerCase() !== local.email.toLowerCase()
  ) {
    throw new Error("Identity migration requires a verified primary email");
  }
}

function checkOrganizationReuse(
  local: typeof organization.$inferSelect,
  remote: RemoteOrganization,
): void {
  if (
    local.clerkOrgId
      ? remote.id !== local.clerkOrgId
      : remote.slug !== local.slug || remote.privateMetadata?.useagentOrganizationId !== local.id
  ) {
    throw new Error("Organization migration conflict");
  }
}

async function preflight(api: MigrationClient, tx: DbTx, retainedUserIds: ReadonlySet<string>) {
  // Readers continue; every identity writer waits until all local bindings commit together.
  await tx.execute(
    sql`LOCK TABLE "user", organization, member, invitation IN SHARE ROW EXCLUSIVE MODE`,
  );
  const users = await tx.select().from(user).orderBy(asc(user.createdAt), asc(user.id));
  const organizations = await tx
    .select()
    .from(organization)
    .orderBy(asc(organization.createdAt), asc(organization.id));
  const memberships = await tx.select().from(member);
  const pending = await tx
    .select({ id: invitation.id })
    .from(invitation)
    .where(and(eq(invitation.status, "pending"), gt(invitation.expiresAt, new Date())))
    .limit(1);
  for (const id of retainedUserIds) {
    const local = users.find((row) => row.id === id);
    if (!local || local.clerkUserId) throw new Error("Retained identity migration conflict");
  }
  if (pending.length) throw new Error("Pending invitations require migration");
  const settings = await api.instance.getOrganizationSettings();
  if (!settings.enabled) throw new Error("Organizations must be enabled");
  if (settings.slugDisabled) throw new Error("Organization slugs must be enabled");
  for (const row of memberships)
    if (!identityRole(row.role)) throw new Error("Identity migration conflict");
  const remoteUsers = new Map<string, RemoteUser>();
  const subjects = new Set<string>();
  for (const local of users) {
    if (retainedUserIds.has(local.id)) continue;
    let remote: RemoteUser | undefined;
    if (local.clerkUserId) remote = await api.users.getUser(local.clerkUserId);
    else {
      const candidates = await api.users.getUserList({ emailAddress: [local.email], limit: 2 });
      if (candidates.totalCount > 1) throw new Error("Identity migration conflict");
      remote = candidates.data[0];
    }
    if (remote) {
      checkUserReuse(local, remote);
      if (subjects.has(remote.id)) throw new Error("Identity migration conflict");
      subjects.add(remote.id);
      remoteUsers.set(local.id, remote);
    }
  }
  for (const local of organizations) {
    let remote: RemoteOrganization;
    try {
      remote = await api.organizations.getOrganization(
        local.clerkOrgId ? { organizationId: local.clerkOrgId } : { slug: local.slug },
      );
    } catch (error) {
      if (!local.clerkOrgId && identityNotFound(error)) continue;
      throw error;
    }
    checkOrganizationReuse(local, remote);
    const expected = new Map<string, "owner" | "member" | null>();
    for (const row of memberships) {
      const subject = remoteUsers.get(row.userId)?.id;
      if (row.organizationId === local.id && subject) expected.set(subject, identityRole(row.role));
    }
    for (let offset = 0; ; offset += 100) {
      const page = await api.organizations.getOrganizationMembershipList({
        organizationId: remote.id,
        offset,
        limit: 100,
      });
      for (const row of page.data) {
        const subject = row.publicUserData?.userId;
        if (
          row.organization.id !== remote.id ||
          !subject ||
          !expected.has(subject) ||
          expected.get(subject) !== identityRole(row.role)
        ) {
          throw new Error("Organization membership migration conflict");
        }
      }
      if (offset + page.data.length >= page.totalCount) break;
      if (!page.data.length) throw new Error("Organization membership list is incomplete");
    }
  }
  return { users, organizations, memberships };
}

export async function migrateIdentity(
  api: MigrationClient = identityClient(),
  retainedUserIds: ReadonlySet<string> = new Set(),
) {
  return withIdentitySync(async (tx) => {
    const source = await preflight(api, tx, retainedUserIds);
    const counts = {
      usersCreated: 0,
      usersLinked: 0,
      usersExisting: 0,
      organizationsCreated: 0,
      organizationsLinked: 0,
      organizationsExisting: 0,
      membershipsCreated: 0,
      membershipsExisting: 0,
    };
    let usersRetained = 0;
    let membershipsRetained = 0;
    for (const original of source.users) {
      if (retainedUserIds.has(original.id)) {
        usersRetained++;
        continue;
      }
      const [local] = await tx.select().from(user).where(eq(user.id, original.id));
      if (!local) throw new Error("Local identity changed during migration");
      if (local.clerkUserId) {
        const remote = await api.users.getUser(local.clerkUserId);
        if (remote.id !== local.clerkUserId) throw new Error("Identity migration conflict");
        counts.usersExisting++;
        continue;
      }
      const candidates = await api.users.getUserList({ emailAddress: [local.email], limit: 2 });
      if (candidates.totalCount > 1) throw new Error("Identity migration conflict");
      let remote = candidates.data[0];
      if (remote) {
        checkUserReuse(local, remote);
        counts.usersLinked++;
      } else {
        remote = await api.users.createUser({
          emailAddress: [local.email],
          firstName: local.name,
          externalId: local.id,
          skipPasswordRequirement: true,
        });
        counts.usersCreated++;
      }
      const [linked] = await tx
        .update(user)
        .set({ clerkUserId: remote.id })
        .where(and(eq(user.id, local.id), isNull(user.clerkUserId)))
        .returning({ id: user.id });
      if (!linked) throw new Error("Identity migration conflict");
    }

    for (const original of source.organizations) {
      const [local] = await tx.select().from(organization).where(eq(organization.id, original.id));
      if (!local) throw new Error("Local organization changed during migration");
      if (local.clerkOrgId) {
        const remote = await api.organizations.getOrganization({
          organizationId: local.clerkOrgId,
        });
        if (remote.id !== local.clerkOrgId) throw new Error("Identity migration conflict");
        counts.organizationsExisting++;
        continue;
      }
      let remote:
        | Awaited<ReturnType<MigrationClient["organizations"]["getOrganization"]>>
        | undefined;
      try {
        remote = await api.organizations.getOrganization({ slug: local.slug });
      } catch (error) {
        if (!identityNotFound(error)) throw error;
      }
      if (remote) {
        checkOrganizationReuse(local, remote);
        counts.organizationsLinked++;
      } else {
        const owners = await tx
          .select({ subject: user.clerkUserId, role: member.role })
          .from(member)
          .innerJoin(user, eq(user.id, member.userId))
          .where(eq(member.organizationId, local.id))
          .orderBy(asc(member.createdAt), asc(member.id));
        const owner = owners.find((row) => identityRole(row.role) === "owner");
        remote = await api.organizations.createOrganization({
          name: local.name,
          slug: local.slug,
          privateMetadata: { useagentOrganizationId: local.id },
          ...(owner?.subject ? { createdBy: owner.subject } : {}),
        });
        counts.organizationsCreated++;
      }
      const [linked] = await tx
        .update(organization)
        .set({ clerkOrgId: remote.id })
        .where(and(eq(organization.id, local.id), isNull(organization.clerkOrgId)))
        .returning({ id: organization.id });
      if (!linked) throw new Error("Identity migration conflict");
    }

    for (const original of source.memberships) {
      if (retainedUserIds.has(original.userId)) {
        membershipsRetained++;
        continue;
      }
      const [local] = await tx
        .select({
          role: member.role,
          userId: user.clerkUserId,
          organizationId: organization.clerkOrgId,
        })
        .from(member)
        .innerJoin(user, eq(user.id, member.userId))
        .innerJoin(organization, eq(organization.id, member.organizationId))
        .where(eq(member.id, original.id));
      if (!local) throw new Error("Local membership changed during migration");
      const role = identityRole(local.role);
      if (!local.userId || !local.organizationId || !role)
        throw new Error("Identity migration conflict");
      const remoteRole = role === "owner" ? "org:admin" : "org:member";
      const current = await api.organizations.getOrganizationMembershipList({
        organizationId: local.organizationId,
        userId: [local.userId],
        limit: 2,
      });
      const existing = current.data[0];
      if (current.totalCount > 1) throw new Error("Identity migration conflict");
      if (existing) {
        if (
          existing.organization.id !== local.organizationId ||
          existing.publicUserData?.userId !== local.userId ||
          identityRole(existing.role) !== role
        ) {
          throw new Error("Identity migration conflict");
        }
        counts.membershipsExisting++;
      } else {
        await api.organizations.createOrganizationMembership({
          organizationId: local.organizationId,
          userId: local.userId,
          role: remoteRole,
        });
        counts.membershipsCreated++;
      }
    }
    return retainedUserIds.size ? { ...counts, usersRetained, membershipsRetained } : counts;
  });
}

async function main(): Promise<void> {
  try {
    const args = Bun.argv.slice(2);
    if (args.length === 0 || (args.length === 1 && args[0] === "--check")) {
      // Inspect the intended size without calling Clerk or disclosing identity values.
      const [counts] = await client`SELECT
        (SELECT count(*)::int FROM "user") AS users,
        (SELECT count(*)::int FROM organization) AS organizations,
        (SELECT count(*)::int FROM member) AS memberships,
        (SELECT count(*)::int FROM invitation WHERE status = 'pending' AND expires_at > now()) AS pending_invitations`;
      console.log(JSON.stringify(counts));
      return;
    }
    if (args.length !== 1 || args[0] !== "--execute") throw new Error("Invalid migration command");
    console.log(JSON.stringify(await migrateIdentity()));
  } catch {
    console.error(JSON.stringify({ failed: 1 }));
    process.exitCode = 1;
  } finally {
    await client.end({ timeout: 5 });
  }
}

if (import.meta.main) await main();
