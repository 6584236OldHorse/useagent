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


test("the resend guard resolves the organisation itself and sees past an expired row", async () => {
  const org = await createOrgSession("guard");
  const admin = await createOrgSession("guard-admin");
  const [adminUser] = await db.select({ id: user.id }).from(user).where(eq(user.email, admin.email));
  await db.insert(member).values({
    id: `member_${crypto.randomUUID()}`,
    organizationId: org.orgId,
    userId: adminUser!.id,
    role: "admin",
    createdAt: new Date(),
  });
  // An expired member invitation for the same address sits beside the live owner one.
  const [ownerUser] = await db.select({ id: user.id }).from(user).where(eq(user.email, org.email));
  await db.insert(invitation).values({
    id: `inv_${crypto.randomUUID()}`,
    organizationId: org.orgId,
    email: "twice@example.test",
    role: "member",
    status: "pending",
    expiresAt: new Date(Date.now() - 1000),
    inviterId: ownerUser!.id,
  });
  const ownerInvite = await json("/api/auth/organization/invite-member", {
    method: "POST",
    cookies: org.cookies,
    body: { organizationId: org.orgId, email: "twice@example.test", role: "owner" },
  });
  expect(ownerInvite.status).toBe(200);
  // The admin's session must have the org active for the empty-id case to mean anything.
  const activate = await json("/api/auth/organization/set-active", {
    method: "POST",
    cookies: admin.cookies,
    body: { organizationId: org.orgId },
  });
  expect(activate.status).toBe(200);
  for (const organizationId of ["", undefined]) {
    const attempt = await json<{ message?: string }>("/api/auth/organization/invite-member", {
      method: "POST",
      cookies: admin.cookies,
      body: { organizationId, email: "twice@example.test", role: "member", resend: true },
    });
    expect(attempt.status).toBe(403);
  }
});

test("the invitation preview answers the recipient, even after the inviter has left", async () => {
  const org = await createOrgSession("preview");
  const invitee = await createOrgSession("invitee");
  const invite = await json<{ id: string }>("/api/auth/organization/invite-member", {
    method: "POST",
    cookies: org.cookies,
    body: { organizationId: org.orgId, email: invitee.email, role: "admin" },
  });
  expect(invite.status).toBe(200);
  const stranger = await createOrgSession("stranger");
  const wrong = await json(`/api/auth/invitation-preview?id=${invite.body.id}`, { cookies: stranger.cookies });
  expect(wrong.status).toBe(403);
  const missing = await json("/api/auth/invitation-preview?id=nope", { cookies: invitee.cookies });
  expect(missing.status).toBe(404);
  const ok = await json<{ organizationName: string; inviterEmail: string | null; role: string }>(
    `/api/auth/invitation-preview?id=${invite.body.id}`,
    { cookies: invitee.cookies },
  );
  expect(ok.status).toBe(200);
  expect(ok.body.organizationName).toContain("Org preview");
  expect(ok.body.inviterEmail).toBe(org.email);
  expect(ok.body.role).toBe("admin");
  // The inviter leaves; the invitation still previews and still accepts.
  const [inviter] = await db.select({ id: user.id }).from(user).where(eq(user.email, org.email));
  await db.delete(member).where(eq(member.userId, inviter!.id));
  const after = await json<{ inviterEmail: string | null }>(`/api/auth/invitation-preview?id=${invite.body.id}`, {
    cookies: invitee.cookies,
  });
  expect(after.status).toBe(200);
  expect(after.body.inviterEmail).toBe(org.email);
  const accepted = await json("/api/auth/organization/accept-invitation", {
    method: "POST",
    cookies: invitee.cookies,
    body: { invitationId: invite.body.id },
  });
  expect(accepted.status).toBe(200);
  const gone = await json(`/api/auth/invitation-preview?id=${invite.body.id}`, { cookies: invitee.cookies });
  expect(gone.status).toBe(404);
});

test("a resend keeps the stored role whatever the request names, and renews the deadline", async () => {
  const org = await createOrgSession("renew");
  const admin = await createOrgSession("renew-admin");
  const [adminUser] = await db.select({ id: user.id }).from(user).where(eq(user.email, admin.email));
  await db.insert(member).values({
    id: `member_${crypto.randomUUID()}`,
    organizationId: org.orgId,
    userId: adminUser!.id,
    role: "admin",
    createdAt: new Date(),
  });
  const invite = await json<{ id: string; expiresAt: string }>("/api/auth/organization/invite-member", {
    method: "POST",
    cookies: org.cookies,
    body: { organizationId: org.orgId, email: "keep@example.test", role: "member" },
  });
  expect(invite.status).toBe(200);
  await db
    .update(invitation)
    .set({ expiresAt: new Date(Date.now() + 60_000) })
    .where(eq(invitation.id, invite.body.id));
  const resent = await json<{ id: string; role: string; expiresAt: string }>("/api/auth/organization/invite-member", {
    method: "POST",
    cookies: admin.cookies,
    body: { organizationId: org.orgId, email: "keep@example.test", role: "owner", resend: true },
  });
  expect(resent.status).toBe(200);
  expect(resent.body.id).toBe(invite.body.id);
  expect(resent.body.role).toBe("member");
  const [row] = await db.select({ role: invitation.role, expiresAt: invitation.expiresAt }).from(invitation).where(eq(invitation.id, invite.body.id));
  expect(row!.role).toBe("member");
  expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
});

test("an outsider or a plain member gets the same answer whatever invitations exist", async () => {
  const org = await createOrgSession("closed");
  for (const [email, role] of [["closed-owner@example.test", "owner"], ["closed-member@example.test", "member"]] as const) {
    const res = await json("/api/auth/organization/invite-member", {
      method: "POST",
      cookies: org.cookies,
      body: { organizationId: org.orgId, email, role },
    });
    expect(res.status).toBe(200);
  }
  const stranger = await createOrgSession("stranger");
  const plain = await createOrgSession("plain");
  const [plainUser] = await db.select({ id: user.id }).from(user).where(eq(user.email, plain.email));
  await db.insert(member).values({
    id: `member_${crypto.randomUUID()}`,
    organizationId: org.orgId,
    userId: plainUser!.id,
    role: "member",
    createdAt: new Date(),
  });
  const answers = new Set<string>();
  for (const cookies of [stranger.cookies, plain.cookies]) {
    for (const email of ["closed-owner@example.test", "closed-member@example.test", "nobody@example.test"]) {
      const res = await json<{ message?: string }>("/api/auth/organization/invite-member", {
        method: "POST",
        cookies,
        body: { organizationId: org.orgId, email, role: "member", resend: true },
      });
      answers.add(`${res.status} ${res.body.message}`);
    }
  }
  expect([...answers]).toEqual(["403 You are not allowed to invite people to this workspace"]);
});

test("a role is one exact word, on a fresh invitation and on a role change", async () => {
  const org = await createOrgSession("roles");
  const other = await createOrgSession("roles-other");
  const [otherUser] = await db.select({ id: user.id }).from(user).where(eq(user.email, other.email));
  const memberId = `member_${crypto.randomUUID()}`;
  await db.insert(member).values({ id: memberId, organizationId: org.orgId, userId: otherUser!.id, role: "member", createdAt: new Date() });
  for (const role of ["admin, owner", "owner ", ["owner"]]) {
    const invite = await json<{ message?: string }>("/api/auth/organization/invite-member", {
      method: "POST",
      cookies: org.cookies,
      body: { organizationId: org.orgId, email: "exact@example.test", role },
    });
    expect(invite.status).toBe(400);
    expect(invite.body.message).toContain("Role must be");
    const change = await json<{ message?: string }>("/api/auth/organization/update-member-role", {
      method: "POST",
      cookies: org.cookies,
      body: { organizationId: org.orgId, memberId, role },
    });
    expect(change.status).toBe(400);
  }
  const fine = await json("/api/auth/organization/invite-member", {
    method: "POST",
    cookies: org.cookies,
    body: { organizationId: org.orgId, email: "exact@example.test", role: "admin" },
  });
  expect(fine.status).toBe(200);
});

test("a resend from an untrusted or missing origin is refused before anything is read", async () => {
  const org = await createOrgSession("origin");
  const invite = await json("/api/auth/organization/invite-member", {
    method: "POST",
    cookies: org.cookies,
    body: { organizationId: org.orgId, email: "origin@example.test", role: "member" },
  });
  expect(invite.status).toBe(200);
  for (const origin of ["https://elsewhere.example", ""]) {
    const res = await json<{ message?: string }>("/api/auth/organization/invite-member", {
      method: "POST",
      cookies: org.cookies,
      headers: { origin },
      body: { organizationId: org.orgId, email: "origin@example.test", role: "member", resend: true },
    });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Invalid origin");
  }
});

test("a mail failure on resend still renews the invitation and answers 200", async () => {
  const relay = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        socket.write("220 ready\r\n");
      },
      data(socket) {
        socket.end();
      },
    },
  });
  const saved = { ...process.env };
  process.env.CONNECTOR_EMAIL_HOST = "127.0.0.1";
  process.env.CONNECTOR_EMAIL_PORT = String(relay.port);
  process.env.CONNECTOR_EMAIL_SECURE = "false";
  process.env.CONNECTOR_EMAIL_FROM = "hello@example.test";
  try {
    const org = await createOrgSession("mailfail");
    const invite = await json<{ id: string }>("/api/auth/organization/invite-member", {
      method: "POST",
      cookies: org.cookies,
      body: { organizationId: org.orgId, email: "mailfail@example.test", role: "member" },
    });
    expect(invite.status).toBe(200);
    await db.update(invitation).set({ expiresAt: new Date(Date.now() + 60_000) }).where(eq(invitation.id, invite.body.id));
    const resent = await json<{ id: string; expiresAt: string }>("/api/auth/organization/invite-member", {
      method: "POST",
      cookies: org.cookies,
      body: { organizationId: org.orgId, email: "mailfail@example.test", role: "member", resend: true },
    });
    expect(resent.status).toBe(200);
    expect(resent.body.id).toBe(invite.body.id);
    expect(new Date(resent.body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
  } finally {
    for (const key of ["CONNECTOR_EMAIL_HOST", "CONNECTOR_EMAIL_PORT", "CONNECTOR_EMAIL_SECURE", "CONNECTOR_EMAIL_FROM"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    relay.stop(true);
  }
});
