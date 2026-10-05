import { afterAll, describe, expect, test } from "bun:test";
import { like } from "drizzle-orm";

await import("./helpers");
const { db } = await import("../src/db/client");
const { invitation, organization, user } = await import("../src/db/auth-schema");
const {
  deliverInvitation,
  invitationLink,
  invitationMailConfig,
  invitationMessage,
  invitedSignupAllowed,
} = await import("../src/auth-invitations");

const prefix = `invite-${crypto.randomUUID()}`;
const orgId = `org_${crypto.randomUUID()}`;
const inviterId = `user_${crypto.randomUUID()}`;

afterAll(async () => {
  await db.delete(invitation).where(like(invitation.email, `${prefix}%`));
  await db.delete(organization).where(like(organization.slug, `${prefix}%`));
  await db.delete(user).where(like(user.email, `${prefix}%`));
});

describe("invitation mail configuration", () => {
  test("needs a host and a from address, defaults to implicit TLS on 465", () => {
    expect(invitationMailConfig({})).toBeNull();
    expect(invitationMailConfig({ CONNECTOR_EMAIL_HOST: "smtp.example.test" })).toBeNull();
    expect(
      invitationMailConfig({ CONNECTOR_EMAIL_HOST: "smtp.example.test", CONNECTOR_EMAIL_FROM: "hello@example.test" }),
    ).toEqual({ host: "smtp.example.test", port: 465, secure: true, user: undefined, pass: undefined, from: "hello@example.test" });
    expect(
      invitationMailConfig({
        CONNECTOR_EMAIL_HOST: "localhost",
        CONNECTOR_EMAIL_PORT: "1025",
        CONNECTOR_EMAIL_FROM: "hello@example.test",
        CONNECTOR_EMAIL_USER: "u",
        CONNECTOR_EMAIL_PASS: "p",
      }),
    ).toMatchObject({ port: 1025, secure: false, user: "u", pass: "p" });
    expect(
      invitationMailConfig({ CONNECTOR_EMAIL_HOST: "h", CONNECTOR_EMAIL_FROM: "f", CONNECTOR_EMAIL_PORT: "nope" }),
    ).toBeNull();
  });

  test("the link and the message name the workspace, the inviter and the deadline", () => {
    expect(invitationLink("inv 1", "https://app.example.test")).toBe(
      "https://app.example.test/accept-invitation/inv%201",
    );
    const message = invitationMessage({
      organization: "Acme",
      inviter: "Dana",
      role: "admin",
      link: "https://app.example.test/accept-invitation/inv1",
      expiresAt: new Date("2026-09-20T10:00:00Z"),
    });
    expect(message.subject).toBe("Dana invited you to Acme on useAgent");
    expect(message.text).toContain("join Acme as an admin");
    expect(message.text).toContain("https://app.example.test/accept-invitation/inv1");
    expect(message.text).toContain("until 2026-09-20");
  });

  test("delivers through the given transport, or only logs the link without one", async () => {
    const sent: Array<{ to: string[]; subject: string; from: string }> = [];
    const data = {
      id: "inv1",
      email: "new@example.test",
      role: "member",
      organization: { name: "Acme" },
      invitation: { expiresAt: new Date("2026-09-20T10:00:00Z") },
      inviter: { user: { name: "  ", email: "dana@example.test" } },
    };
    expect(await deliverInvitation(data, null)).toBe("link_only");
    expect(sent).toEqual([]);
    const config = { host: "smtp.example.test", port: 465, secure: true, from: "hello@example.test" };
    const send = async (_cfg: unknown, msg: { to: string[]; subject: string; from: string }) => {
      sent.push({ to: msg.to, subject: msg.subject, from: msg.from });
    };
    expect(await deliverInvitation(data, config, send as never)).toBe("sent");
    // A blank inviter name falls back to the inviter's email.
    expect(sent).toEqual([{ to: ["new@example.test"], subject: "dana@example.test invited you to Acme on useAgent", from: "hello@example.test" }]);
  });
});

describe("invited signup", () => {
  test("only a pending, unexpired invitation opens the door, whatever the email's case", async () => {
    await db.insert(user).values({ id: inviterId, name: prefix, email: `${prefix}-inviter@example.test`, emailVerified: true });
    await db.insert(organization).values({ id: orgId, name: prefix, slug: `${prefix}-org`, createdAt: new Date() });
    const inDay = new Date(Date.now() + 86_400_000);
    const yesterday = new Date(Date.now() - 86_400_000);
    await db.insert(invitation).values([
      { id: `inv_${crypto.randomUUID()}`, organizationId: orgId, email: `${prefix}-open@example.test`, role: "member", status: "pending", expiresAt: inDay, inviterId },
      { id: `inv_${crypto.randomUUID()}`, organizationId: orgId, email: `${prefix}-stale@example.test`, role: "member", status: "pending", expiresAt: yesterday, inviterId },
      { id: `inv_${crypto.randomUUID()}`, organizationId: orgId, email: `${prefix}-gone@example.test`, role: "member", status: "canceled", expiresAt: inDay, inviterId },
    ]);
    expect(await invitedSignupAllowed(`${prefix}-open@example.test`)).toBe(true);
    expect(await invitedSignupAllowed(` ${prefix.toUpperCase()}-OPEN@EXAMPLE.TEST `)).toBe(true);
    expect(await invitedSignupAllowed(`${prefix}-stale@example.test`)).toBe(false);
    expect(await invitedSignupAllowed(`${prefix}-gone@example.test`)).toBe(false);
    expect(await invitedSignupAllowed(`${prefix}-nobody@example.test`)).toBe(false);
  });
});
