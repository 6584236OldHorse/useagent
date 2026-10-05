import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { invitation } from "../src/db/schema";
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
