import { afterAll, expect, test } from "bun:test";
import { eq, like } from "drizzle-orm";

const prior = {
  NODE_ENV: process.env.NODE_ENV,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
};

await import("./helpers");
const { createAuthServer } = await import("../src/auth");
const { handleAuthRequest } = await import("../src/auth/routes");
const { db } = await import("../src/db/client");
const { account, invitation, member, organization, session, user } = await import("../src/db/auth-schema");
process.env.GOOGLE_CLIENT_ID = "google-test-client";
process.env.GOOGLE_CLIENT_SECRET = "google-test-secret";
process.env.BETTER_AUTH_SECRET = "google-auth-test-secret-0123456789abcdef";
process.env.NODE_ENV = "production";
const auth = createAuthServer();
for (const [name, value] of Object.entries(prior)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const prefix = `google-auth-${crypto.randomUUID()}`;
const email = `${prefix}@example.test`;
const userId = `user_${crypto.randomUUID()}`;
const unverifiedUserId = `user_${crypto.randomUUID()}`;
const unverifiedEmail = `${prefix}-unverified@example.test`;
const orgId = `org_${crypto.randomUUID()}`;
const context = await auth.$context;
const google = context.socialProviders.find((provider) => provider.id === "google");
if (!google) throw new Error("Google test provider missing");
google.verifyIdToken = async () => true;
google.getUserInfo = async ({ idToken }) => ({
  user:
    idToken === "existing"
      ? { id: "google-existing", email, emailVerified: true, name: prefix }
      : idToken === "invited"
        ? { id: "google-invited", email: `${prefix}-invited@example.test`, emailVerified: true, name: `${prefix}-invited` }
      : idToken === "unverified"
        ? {
            id: "google-unverified",
            email: unverifiedEmail,
            emailVerified: false,
            name: `${prefix}-unverified`,
          }
      : {
          id: "google-unknown",
          email: `${prefix}-unknown@example.test`,
          emailVerified: true,
          name: `${prefix}-unknown`,
        },
});

afterAll(async () => {
  await db.delete(user).where(like(user.email, `${prefix}%`));
  await db.delete(organization).where(like(organization.slug, `${prefix}%`));
});

test("Google links a verified existing user and rejects an unknown user in production", async () => {
  expect(auth.options.emailAndPassword).toMatchObject({ enabled: true, disableSignUp: true });
  process.env.NODE_ENV = "production";
  process.env.GOOGLE_CLIENT_ID = "google-test-client";
  process.env.GOOGLE_CLIENT_SECRET = "google-test-secret";
  const config = await handleAuthRequest(
    new Request("http://localhost:3211/api/auth/provider-config"),
  );
  expect(await config.json()).toMatchObject({ google: true, emailPassword: true });
  for (const [name, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await db.insert(user).values([
    { id: userId, name: prefix, email, emailVerified: false },
    {
      id: unverifiedUserId,
      name: `${prefix}-unverified`,
      email: unverifiedEmail,
      emailVerified: false,
    },
  ]);
  await db.insert(organization).values({
    id: orgId,
    name: prefix,
    slug: `${prefix}-org`,
    createdAt: new Date(),
  });
  await db.insert(member).values({
    id: `member_${crypto.randomUUID()}`,
    organizationId: orgId,
    userId,
    role: "owner",
    createdAt: new Date(),
  });
  const linked = await auth.api.signInSocial({
    body: { provider: "google", idToken: { token: "existing" } },
  });
  expect(linked.user.id).toBe(userId);
  expect(await db.select().from(member).where(eq(member.userId, userId))).toHaveLength(1);
  expect(await db.select().from(account).where(eq(account.userId, userId))).toHaveLength(1);

  await expect(
    auth.api.signInSocial({ body: { provider: "google", idToken: { token: "unverified" } } }),
  ).rejects.toThrow("account not linked");
  expect(await db.select().from(account).where(eq(account.userId, unverifiedUserId))).toEqual([]);
  expect(await db.select().from(session).where(eq(session.userId, unverifiedUserId))).toEqual([]);

  process.env.NODE_ENV = "production";
  try {
    await expect(
      auth.api.signInSocial({ body: { provider: "google", idToken: { token: "unknown" } } }),
    ).rejects.toThrow("Account creation is disabled");
  } finally {
    if (prior.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior.NODE_ENV;
  }
  expect(await db.select().from(user).where(eq(user.email, `${prefix}-unknown@example.test`))).toEqual(
    [],
  );
});

test("a pending invitation lets a new Google identity create its account in production", async () => {
  const invitedEmail = `${prefix}-invited@example.test`;
  await db.insert(invitation).values({
    id: `inv_${crypto.randomUUID()}`,
    organizationId: orgId,
    email: invitedEmail,
    role: "member",
    status: "pending",
    expiresAt: new Date(Date.now() + 86_400_000),
    inviterId: userId,
  });
  process.env.NODE_ENV = "production";
  try {
    const created = await auth.api.signInSocial({ body: { provider: "google", idToken: { token: "invited" } } });
    expect(created.user.email).toBe(invitedEmail);
  } finally {
    if (prior.NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior.NODE_ENV;
  }
  expect(await db.select().from(user).where(eq(user.email, invitedEmail))).toHaveLength(1);
});
