import { expect, test } from "bun:test";
import { count, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { member, user } from "../src/db/schema";
import { createOrgSession, json } from "./helpers";

// Ledger G10: the library stops an organisation at 100 members by default, and
// the invitations lane met that limit by accident. Ours sits where no real
// team reaches it, so the 101st person joins like the second did.

async function size(organizationId: string): Promise<number> {
  const [row] = await db.select({ members: count() }).from(member).where(eq(member.organizationId, organizationId));
  return row!.members;
}

test("the 101st member joins through a real invitation", async () => {
  const org = await createOrgSession("crowd");
  const crowd = Array.from({ length: 99 }, (_, index) => ({
    id: `user_${crypto.randomUUID()}`,
    name: `Crowd ${index}`,
    email: `crowd-${index}-${crypto.randomUUID()}@example.test`,
    emailVerified: true,
  }));
  await db.insert(user).values(crowd);
  await db.insert(member).values(
    crowd.map((person) => ({
      id: `member_${crypto.randomUUID()}`,
      organizationId: org.orgId,
      userId: person.id,
      role: "member",
      createdAt: new Date(),
    })),
  );
  expect(await size(org.orgId)).toBe(100);

  const late = await createOrgSession("late");
  const invited = await json<{ id: string }>("/api/auth/organization/invite-member", {
    method: "POST",
    cookies: org.cookies,
    body: { organizationId: org.orgId, email: late.email, role: "member" },
  });
  expect(invited.status).toBe(200);
  const accepted = await json<{ message?: string }>("/api/auth/organization/accept-invitation", {
    method: "POST",
    cookies: late.cookies,
    body: { invitationId: invited.body.id },
  });
  expect(accepted.status).toBe(200);
  expect(await size(org.orgId)).toBe(101);
});
