import { afterAll, describe, expect, test } from "bun:test";
import { like } from "drizzle-orm";

await import("./helpers");
const { db } = await import("../src/db/client");
const { env, invitationMailConfig } = await import("../src/env");
const { invitation, organization, user } = await import("../src/db/auth-schema");
const {
  CONFIRMATION_TTL_MS,
  confirmationLink,
  confirmationToken,
  deliverInvitation,
  deliverVerification,
  headerSafe,
  invitationLink,
  invitationMessage,
  invitedSignupAllowed,
  readConfirmationToken,
  verificationMessage,
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

  test("the link points at the frontend, not the auth origin, and names the workspace", () => {
    expect(env.FRONTEND_ORIGIN).not.toBe(env.BETTER_AUTH_URL); // the local layout the link must survive
    expect(new URL(invitationLink("x")).origin).toBe(new URL(env.FRONTEND_ORIGIN).origin);
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

  test("a name cannot smuggle a mail header", () => {
    expect(headerSafe("Acme\r\nReply-To: attacker@example.test")).toBe("Acme Reply-To: attacker@example.test");
    const message = invitationMessage({
      organization: "Acme\r\nX-Note: injected",
      inviter: "\u0000",
      role: "member",
      link: "https://app.example.test/accept-invitation/inv1",
      expiresAt: new Date("2026-09-20T10:00:00Z"),
    });
    expect(message.subject).toBe("A teammate invited you to Acme X-Note: injected on useAgent");
    expect(message.subject).not.toMatch(/[\r\n]/);
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
    const send = async (cfg: { timeoutMs?: number }, msg: { to: string[]; subject: string; from: string }) => {
      expect(cfg.timeoutMs).toBe(20_000);
      sent.push({ to: msg.to, subject: msg.subject, from: msg.from });
    };
    expect(await deliverInvitation(data, config, send as never)).toBe("sent");
    // A blank inviter name falls back to the inviter's email.
    expect(sent).toEqual([{ to: ["new@example.test"], subject: "dana@example.test invited you to Acme on useAgent", from: "hello@example.test" }]);
  });
});

describe("sign-up verification mail", () => {
  test("the token names one registration, expires, and cannot be forged or retargeted", () => {
    const token = confirmationToken({ id: "user 1", email: "New@Example.test" }, "secret", 1_000);
    expect(readConfirmationToken(token, "secret", 2_000)).toEqual({ id: "user 1", email: "new@example.test" });
    expect(readConfirmationToken(token, "secret", 1_000 + CONFIRMATION_TTL_MS + 1)).toBe("expired");
    expect(readConfirmationToken(token, "other-secret", 2_000)).toBe("invalid");
    expect(readConfirmationToken(`${token}x`, "secret", 2_000)).toBe("invalid");
    expect(readConfirmationToken("", "secret", 2_000)).toBe("invalid");
    const [payload, signature] = token.split(".");
    const other = Buffer.from(JSON.stringify({ id: "user 2", email: "new@example.test", until: 9e15 })).toString("base64url");
    expect(readConfirmationToken(`${other}.${signature}`, "secret", 2_000)).toBe("invalid");
    expect(readConfirmationToken(`${payload}.`, "secret", 2_000)).toBe("invalid");
    expect(confirmationLink(token, "https://app.example.test")).toBe(
      `https://app.example.test/api/auth/confirm-signup?token=${encodeURIComponent(token)}`,
    );
  });

  test("the mail says what to do when it was not you, and needs a transport", async () => {
    const link = confirmationLink("t.s", "https://app.example.test");
    const message = verificationMessage(link);
    expect(message.subject).toBe("Confirm your useAgent sign-up");
    expect(message.text).toContain(link);
    expect(message.text).toContain("If you did not sign up just now, ignore this");
    await expect(deliverVerification("new@example.test", link, null)).rejects.toThrow("no mail transport");
    const sent: Array<{ to: string[]; subject: string; from: string }> = [];
    const config = { host: "smtp.example.test", port: 465, secure: true, from: "hello@example.test" };
    const send = async (cfg: { timeoutMs?: number }, msg: { to: string[]; subject: string; from: string }) => {
      expect(cfg.timeoutMs).toBe(20_000);
      sent.push({ to: msg.to, subject: msg.subject, from: msg.from });
    };
    await deliverVerification("new@example.test", link, config, send as never);
    expect(sent).toEqual([{ to: ["new@example.test"], subject: "Confirm your useAgent sign-up", from: "hello@example.test" }]);
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
