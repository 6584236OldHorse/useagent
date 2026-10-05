import { and, asc, eq, isNull } from "drizzle-orm";
import { identityClient } from "../src/auth/clerk/client";
import { identityNotFound } from "../src/auth/clerk/directory";
import { identityRole, withIdentitySync } from "../src/auth/clerk/store";
import { client, db } from "../src/db/client";
import { member, organization, user } from "../src/db/auth-schema";

type Client = ReturnType<typeof identityClient>;
export interface MigrationClient {
  users: Pick<Client["users"], "getUser" | "getUserList" | "createUser">;
  organizations: Pick<
    Client["organizations"],
    | "getOrganization"
    | "createOrganization"
    | "getOrganizationMembershipList"
    | "createOrganizationMembership"
  >;
}

export async function migrateIdentity(api: MigrationClient = identityClient()) {
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
  const users = await db.select().from(user).orderBy(asc(user.createdAt), asc(user.id));
  for (const original of users) {
    await withIdentitySync(async (tx) => {
      const [local] = await tx.select().from(user).where(eq(user.id, original.id));
      if (!local) throw new Error("Local identity changed during migration");
      if (local.clerkUserId) {
        const remote = await api.users.getUser(local.clerkUserId);
        if (remote.id !== local.clerkUserId) throw new Error("Identity migration conflict");
        counts.usersExisting++;
        return;
      }
      const candidates = await api.users.getUserList({ emailAddress: [local.email], limit: 2 });
      if (candidates.totalCount > 1) throw new Error("Identity migration conflict");
      let remote = candidates.data[0];
      if (remote) {
        const primary = remote.emailAddresses.find(
          (address) => address.id === remote.primaryEmailAddressId,
        );
        if (
          primary?.verification?.status !== "verified" ||
          primary.emailAddress.toLowerCase() !== local.email.toLowerCase()
        ) {
          throw new Error("Identity migration requires a verified primary email");
        }
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
    });
  }

  const organizations = await db
    .select()
    .from(organization)
    .orderBy(asc(organization.createdAt), asc(organization.id));
  for (const original of organizations) {
    await withIdentitySync(async (tx) => {
      const [local] = await tx.select().from(organization).where(eq(organization.id, original.id));
      if (!local) throw new Error("Local organization changed during migration");
      if (local.clerkOrgId) {
        const remote = await api.organizations.getOrganization({
          organizationId: local.clerkOrgId,
        });
        if (remote.id !== local.clerkOrgId) throw new Error("Identity migration conflict");
        counts.organizationsExisting++;
        return;
      }
      let remote: Awaited<ReturnType<MigrationClient["organizations"]["getOrganization"]>> | undefined;
      try {
        remote = await api.organizations.getOrganization({ slug: local.slug });
      } catch (error) {
        if (!identityNotFound(error)) throw error;
      }
      if (remote) {
        if (remote.slug !== local.slug) throw new Error("Identity migration conflict");
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
    });
  }

  const memberships = await db
    .select({
      id: member.id,
      role: member.role,
      userId: user.clerkUserId,
      organizationId: organization.clerkOrgId,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .innerJoin(organization, eq(organization.id, member.organizationId));
  for (const original of memberships) {
    await withIdentitySync(async (tx) => {
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
          existing.role !== remoteRole
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
    });
  }
  return counts;
}

async function main(): Promise<void> {
  try {
    const args = Bun.argv.slice(2);
    if (args.length === 0 || (args.length === 1 && args[0] === "--check")) {
      // Inspect the intended size without calling Clerk or disclosing identity values.
      const [counts] = await client`SELECT
        (SELECT count(*)::int FROM "user") AS users,
        (SELECT count(*)::int FROM organization) AS organizations,
        (SELECT count(*)::int FROM member) AS memberships`;
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
