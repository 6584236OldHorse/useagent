import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createPersonalOrgForUser } from "../src/auth-hooks";
import { personalWorkspaceName } from "../src/auth/personal-workspace";
import { db } from "../src/db/client";
import { member, organization, user } from "../src/db/schema";
import { firstOrgForUser } from "../src/seed";
import { CookieJar, createOrgSession, fetchApi, json } from "./helpers";

// GET /api/team/workspaces: what the user menu and the first-run page read.

interface Workspace {
  id: string;
  name: string;
  role: string;
  members: number;
  defaultName: boolean;
}
interface Listing {
  activeOrganizationId: string;
  workspaces: Workspace[];
}

test("lists each workspace with the person's role, its size and whether the name is still the default", async () => {
  const org = await createOrgSession("ws");
  const admin = await createOrgSession("ws-admin");
  const [adminUser] = await db.select({ id: user.id }).from(user).where(eq(user.email, admin.email));
  await db.insert(member).values({
    id: `member_${crypto.randomUUID()}`,
    organizationId: org.orgId,
    userId: adminUser!.id,
    role: "admin",
    createdAt: new Date(),
  });

  const mine = await json<Listing>("/api/team/workspaces", { cookies: org.cookies });
  expect(mine.status).toBe(200);
  expect(mine.body.activeOrganizationId).toBe(org.orgId);
  expect(mine.body.workspaces).toHaveLength(2);
  // The sign-up hook's personal workspace: untouched, one member.
  expect(mine.body.workspaces.find((row) => row.id !== org.orgId)).toMatchObject({
    name: "User ws's workspace",
    role: "owner",
    members: 1,
    defaultName: true,
  });
  // The workspace created by hand carries its own name and the admin joined it.
  expect(mine.body.workspaces.find((row) => row.id === org.orgId)).toMatchObject({
    name: "Org ws",
    role: "owner",
    members: 2,
    defaultName: false,
  });

  const theirs = await json<Listing>("/api/team/workspaces", { cookies: admin.cookies });
  expect(theirs.body.activeOrganizationId).toBe(admin.orgId);
  expect(theirs.body.workspaces.find((row) => row.id === org.orgId)).toMatchObject({ role: "admin", members: 2 });
});

test("a session without an active organisation lands in the earliest membership, by creation time not by physical order", async () => {
  // Sign up only: the hook makes the personal workspace, nothing sets it active.
  const email = `landing-${crypto.randomUUID()}@example.com`;
  const jar = new CookieJar();
  const signUp = await fetchApi("/api/auth/sign-up/email", {
    method: "POST",
    body: { name: "Landing", email, password: "password-1234" },
  });
  expect(signUp.status).toBe(200);
  jar.absorb(signUp);
  const [me] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  const [personal] = await db.select().from(member).where(eq(member.userId, me!.id));
  expect(personal).toBeDefined();
  const fresh = await json<Listing>("/api/team/workspaces", { cookies: jar.header() });
  expect(fresh.status).toBe(200);
  expect(fresh.body.activeOrganizationId).toBe(personal!.organizationId);

  // A membership created an hour before the personal one but written after it:
  // the physical order is the opposite of the creation order, and creation wins.
  const other = await createOrgSession("landing-other");
  await db.insert(member).values({
    id: `member_${crypto.randomUUID()}`,
    organizationId: other.orgId,
    userId: me!.id,
    role: "member",
    createdAt: new Date(personal!.createdAt.getTime() - 3_600_000),
  });
  expect(await firstOrgForUser(me!.id)).toBe(other.orgId);
  const listed = await json<Listing>("/api/team/workspaces", { cookies: jar.header() });
  expect(listed.body.activeOrganizationId).toBe(other.orgId);
  expect(listed.body.workspaces.map((row) => row.id)).toEqual([other.orgId, personal!.organizationId]);
});

test("the default-name check matches the name a personal workspace is created with", async () => {
  for (const name of ["  Dana Q  ", "", null]) {
    const id = `user_${crypto.randomUUID()}`;
    const email = `${crypto.randomUUID()}@example.test`;
    await db.insert(user).values({ id, name: name ?? "", email, emailVerified: true });
    const orgId = await createPersonalOrgForUser({ id, name, email });
    expect(orgId).not.toBeNull();
    const [row] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, orgId!));
    expect(row!.name).toBe(personalWorkspaceName({ name, email }));
  }
  expect(personalWorkspaceName({ name: "Dana", email: "dana@example.test" })).toBe("Dana's workspace");
  expect(personalWorkspaceName({ name: " ", email: "dana@example.test" })).toBe("dana's workspace");
  expect(personalWorkspaceName({ name: null, email: "@example.test" })).toBe("workspace's workspace");
});
