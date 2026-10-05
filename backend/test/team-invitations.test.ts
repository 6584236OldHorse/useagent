import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { invitation, member, user } from "../src/db/schema";
import { createOrgSession, json } from "./helpers";

// The pending-invitations read behind the Team card: only this org's pending,
// unexpired rows, newest first, and nothing from another org.

test("lists only the org's pending, unexpired invitations", async () => {
  const org = await createOrgSession("team");
  const other = await createOrgSession("other");
  for (const [email, role] of [["one@example.test", "member"], ["two@example.test", "admin"]] as const) {
    const res = await json("/api/auth/organization/invite-member", {
      method: "POST",
      cookies: org.cookies,
      body: { organizationId: org.orgId, email, role },
    });
    expect(res.status).toBe(200);
  }
  const cancelled = await json<{ id: string }>("/api/auth/organization/invite-member", {
    method: "POST",
    cookies: org.cookies,
    body: { organizationId: org.orgId, email: "gone@example.test", role: "member" },
  });
  expect(cancelled.status).toBe(200);
  await db.update(invitation).set({ status: "canceled" }).where(eq(invitation.id, cancelled.body.id));
  const stale = await json<{ id: string }>("/api/auth/organization/invite-member", {
    method: "POST",
    cookies: org.cookies,
    body: { organizationId: org.orgId, email: "stale@example.test", role: "member" },
  });
  await db.update(invitation).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitation.id, stale.body.id));
  const foreign = await json("/api/auth/organization/invite-member", {
    method: "POST",
    cookies: other.cookies,
    body: { organizationId: other.orgId, email: "elsewhere@example.test", role: "member" },
  });
  expect(foreign.status).toBe(200);

  const listed = await json<{ invitations: Array<{ email: string; role: string; expiresAt: string }> }>(
    "/api/team/invitations",
    { cookies: org.cookies },
  );
  expect(listed.status).toBe(200);
  expect((listed.body as { organizationId?: string }).organizationId).toBe(org.orgId);
  expect(listed.body.invitations.map((i) => i.email)).toEqual(["two@example.test", "one@example.test"]);
  expect(listed.body.invitations[0]?.role).toBe("admin");
  expect(Date.parse(listed.body.invitations[0]?.expiresAt ?? "")).toBeGreaterThan(Date.now());

  // The other org sees only its own.
  const theirs = await json<{ invitations: Array<{ email: string }> }>("/api/team/invitations", { cookies: other.cookies });
  expect(theirs.body.invitations.map((i) => i.email)).toEqual(["elsewhere@example.test"]);
});

test("only an owner can resend an owner invitation, whatever role the resend names", async () => {
  const org = await createOrgSession("owners");
  const admin = await createOrgSession("admin");
  const [adminUser] = await db.select({ id: user.id }).from(user).where(eq(user.email, admin.email));
  await db.insert(member).values({
    id: `member_${crypto.randomUUID()}`,
    organizationId: org.orgId,
    userId: adminUser!.id,
    role: "admin",
    createdAt: new Date(),
  });
  const ownerInvite = await json("/api/auth/organization/invite-member", {
    method: "POST",
    cookies: org.cookies,
    body: { organizationId: org.orgId, email: "future-owner@example.test", role: "owner" },
  });
  expect(ownerInvite.status).toBe(200);
  const memberInvite = await json("/api/auth/organization/invite-member", {
    method: "POST",
    cookies: org.cookies,
    body: { organizationId: org.orgId, email: "future-member@example.test", role: "member" },
  });
  expect(memberInvite.status).toBe(200);

  const bypass = await json<{ message?: string }>("/api/auth/organization/invite-member", {
    method: "POST",
    cookies: admin.cookies,
    body: { organizationId: org.orgId, email: "future-owner@example.test", role: "member", resend: true },
  });
  expect(bypass.status).toBe(403);
  expect(bypass.body.message).toContain("owner");

  const allowed = await json("/api/auth/organization/invite-member", {
    method: "POST",
    cookies: admin.cookies,
    body: { organizationId: org.orgId, email: "future-member@example.test", role: "member", resend: true },
  });
  expect(allowed.status).toBe(200);

  const byOwner = await json("/api/auth/organization/invite-member", {
    method: "POST",
    cookies: org.cookies,
    body: { organizationId: org.orgId, email: "future-owner@example.test", role: "owner", resend: true },
  });
  expect(byOwner.status).toBe(200);
});
