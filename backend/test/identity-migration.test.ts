import { expect, test } from "bun:test";
import type {
  Organization,
  OrganizationMembership,
  OrganizationSettings,
  User,
} from "@clerk/backend";
import { eq } from "drizzle-orm";
import { migrateIdentity, type MigrationClient } from "../scripts/clerk-migrate";
import { pruneIdentityMemberships, withIdentitySync } from "../src/auth/clerk/store";
import { db } from "../src/db/client";
import { invitation, member, organization, user } from "../src/db/auth-schema";
import "./helpers";

test("identity migration resumes by email and slug, preserves local ids and roles, and is idempotent", async () => {
  const localUserId = crypto.randomUUID();
  const localOrgId = `org_${crypto.randomUUID()}`;
  const localMemberId = crypto.randomUUID();
  const slug = `identity-migration-${crypto.randomUUID()}`;
  await db
    .insert(user)
    .values({ id: localUserId, name: "Migration fixture", email: `${slug}@example.test` });
  await db
    .insert(organization)
    .values({ id: localOrgId, name: "Migration fixture", slug, createdAt: new Date() });
  await db.insert(member).values({
    id: localMemberId,
    userId: localUserId,
    organizationId: localOrgId,
    role: "member",
    createdAt: new Date(),
  });
  const beforeUsers = await db.select().from(user);
  const beforeOrganizations = await db.select().from(organization);
  const beforeMembers = await db.select().from(member);
  const remoteUsers = new Map<string, User>();
  const remoteOrganizations = new Map<string, Organization>();
  const remoteMembers = new Map<string, OrganizationMembership>();
  let creates = 0;
  let slugDisabled = true;
  let watchReuse = false;
  let reuseReads = 0;
  let delayedSync: Promise<void> | undefined;
  let syncSawMembership = false;
  const remoteUser = (id: string, email: string) =>
    ({
      id,
      primaryEmailAddressId: `email_${id}`,
      emailAddresses: [
        { id: `email_${id}`, emailAddress: email, verification: { status: "verified" } },
      ],
    }) as User;
  const remoteOrganization = (id: string, name: string, slug: string) =>
    ({ id, name, slug }) as Organization;
  for (const row of beforeUsers) {
    if (row.clerkUserId) remoteUsers.set(row.clerkUserId, remoteUser(row.clerkUserId, row.email));
  }
  for (const row of beforeOrganizations) {
    if (row.clerkOrgId)
      remoteOrganizations.set(
        row.clerkOrgId,
        remoteOrganization(row.clerkOrgId, row.name, row.slug),
      );
  }
  const resumedUser = remoteUser(`user_${crypto.randomUUID()}`, `${slug}@example.test`);
  remoteUsers.set(resumedUser.id, resumedUser);
  const resumedOrg = remoteOrganization(`org_${crypto.randomUUID()}`, "Migration fixture", slug);
  remoteOrganizations.set(resumedOrg.id, resumedOrg);
  const api: MigrationClient = {
    instance: {
      getOrganizationSettings: async () =>
        ({ enabled: true, slugDisabled }) as OrganizationSettings,
    },
    users: {
      getUser: async (id) => {
        const found = remoteUsers.get(id);
        if (!found) throw Object.assign(new Error("missing"), { status: 404 });
        return found;
      },
      getUserList: async (params) => {
        const data = [...remoteUsers.values()].filter((entry) =>
          entry.emailAddresses.some((email) => params?.emailAddress?.includes(email.emailAddress)),
        );
        return { data, totalCount: data.length };
      },
      createUser: async (params) => {
        expect(params.skipPasswordRequirement).toBe(true);
        expect(params.externalId).toBeString();
        const email = params.emailAddress?.[0];
        if (!email) throw new Error("fixture email missing");
        const created = remoteUser(`user_${crypto.randomUUID()}`, email);
        remoteUsers.set(created.id, created);
        creates++;
        return created;
      },
    },
    organizations: {
      getOrganization: async (params) => {
        const found =
          "organizationId" in params
            ? remoteOrganizations.get(params.organizationId)
            : [...remoteOrganizations.values()].find((entry) => entry.slug === params.slug);
        if (!found) throw Object.assign(new Error("missing"), { status: 404 });
        if (watchReuse && "slug" in params && params.slug === slug && ++reuseReads === 2) {
          delayedSync = withIdentitySync(async (tx) => {
            const remoteOrgIds = new Set(
              [...remoteMembers.values()]
                .filter((row) => row.publicUserData?.userId === resumedUser.id)
                .map((row) => row.organization.id),
            );
            syncSawMembership = remoteOrgIds.has(resumedOrg.id);
            await pruneIdentityMemberships(localUserId, remoteOrgIds, tx);
          });
        }
        return found;
      },
      createOrganization: async (params) => {
        const created = remoteOrganization(
          `org_${crypto.randomUUID()}`,
          params.name,
          params.slug ?? "missing",
        );
        Object.assign(created, { privateMetadata: params.privateMetadata });
        remoteOrganizations.set(created.id, created);
        creates++;
        if (params.createdBy)
          remoteMembers.set(`${created.id}:${params.createdBy}`, {
            id: crypto.randomUUID(),
            organization: created,
            publicUserData: { userId: params.createdBy },
            role: "org:admin",
          } as OrganizationMembership);
        return created;
      },
      getOrganizationMembershipList: async (params) => {
        const data = [...remoteMembers.values()].filter(
          (entry) =>
            entry.organization.id === params.organizationId &&
            (!params.userId || params.userId.includes(entry.publicUserData?.userId ?? "")),
        );
        return { data, totalCount: data.length };
      },
      createOrganizationMembership: async (params) => {
        const remote = remoteOrganizations.get(params.organizationId);
        if (!remote) throw new Error("fixture organization missing");
        const created = {
          id: crypto.randomUUID(),
          organization: remote,
          publicUserData: { userId: params.userId },
          role: params.role,
        } as OrganizationMembership;
        remoteMembers.set(`${params.organizationId}:${params.userId}`, created);
        creates++;
        return created;
      },
    },
  };
  try {
    await expect(migrateIdentity(api)).rejects.toThrow("Organization slugs must be enabled");
    expect(creates).toBe(0);
    expect(await db.select().from(user)).toEqual(beforeUsers);
    slugDisabled = false;
    await expect(migrateIdentity(api)).rejects.toThrow("Organization migration conflict");
    expect(creates).toBe(0);
    expect(await db.select().from(user)).toEqual(beforeUsers);
    Object.assign(resumedOrg, { privateMetadata: { useagentOrganizationId: localOrgId } });
    remoteMembers.set("unexplained-owner", {
      id: "unexplained-owner",
      organization: resumedOrg,
      publicUserData: { userId: "unexplained-user" },
      role: "org:admin",
    } as OrganizationMembership);
    await expect(migrateIdentity(api)).rejects.toThrow(
      "Organization membership migration conflict",
    );
    expect(creates).toBe(0);
    remoteMembers.delete("unexplained-owner");
    const invitationId = crypto.randomUUID();
    await db.insert(invitation).values({
      id: invitationId,
      organizationId: localOrgId,
      inviterId: localUserId,
      email: "pending@example.test",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(migrateIdentity(api)).rejects.toThrow("Pending invitations require migration");
    expect(creates).toBe(0);
    await db.delete(invitation).where(eq(invitation.id, invitationId));
    watchReuse = true;
    const first = await migrateIdentity(api);
    expect(delayedSync).toBeDefined();
    await delayedSync;
    expect(syncSawMembership).toBe(true);
    expect(first.usersLinked).toBeGreaterThan(0);
    expect(first.organizationsLinked).toBeGreaterThan(0);
    const writes = creates;
    const second = await migrateIdentity(api);
    expect(creates).toBe(writes);
    expect(second.usersCreated + second.organizationsCreated + second.membershipsCreated).toBe(0);
    expect((await db.select().from(user).where(eq(user.id, localUserId)))[0]?.clerkUserId).toBe(
      resumedUser.id,
    );
    expect(
      (await db.select().from(organization).where(eq(organization.id, localOrgId)))[0]?.clerkOrgId,
    ).toBe(resumedOrg.id);
    expect(await db.select().from(member)).toEqual(beforeMembers);
    expect(remoteMembers.get(`${resumedOrg.id}:${resumedUser.id}`)?.role).toBe("org:member");
  } finally {
    await delayedSync?.catch(() => {});
    for (const row of beforeUsers)
      await db.update(user).set({ clerkUserId: row.clerkUserId }).where(eq(user.id, row.id));
    for (const row of beforeOrganizations)
      await db
        .update(organization)
        .set({ clerkOrgId: row.clerkOrgId })
        .where(eq(organization.id, row.id));
    await db.delete(member).where(eq(member.id, localMemberId));
    await db.delete(user).where(eq(user.id, localUserId));
    await db.delete(organization).where(eq(organization.id, localOrgId));
  }
});
