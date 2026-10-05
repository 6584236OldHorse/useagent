import { afterAll, describe, expect, test } from "bun:test";
import { eq, like } from "drizzle-orm";

// Open sign-up is read from the environment per request and, for the library's
// own options, when a server is created: this file sets it after the app has
// booted, builds its own server and routes from it, and restores it at the end.
const OPEN = {
  SIGNUP_OPEN: "1",
  CONNECTOR_EMAIL_HOST: "127.0.0.1",
  CONNECTOR_EMAIL_PORT: "9", // nothing listens: every send fails at once, and no sign-up may care
  CONNECTOR_EMAIL_FROM: "hello@example.test",
  SIGNUP_ALLOWED_DOMAINS: "example.test",
  SIGNUP_INVITE_CODE: "feedback-2026",
};
const prior = Object.fromEntries(Object.keys(OPEN).map((name) => [name, process.env[name]]));
const { BASE, ORIGIN } = await import("./helpers");
Object.assign(process.env, OPEN);
const { createAuthServer } = await import("../src/auth");
const { handleAuthRequest } = await import("../src/auth/routes");
const { SIGNUP_ATTEMPTS_PER_ADDRESS, SIGNUP_ATTEMPTS_PER_CLIENT, createSignupRoutes } = await import("../src/auth/signup-routes");
const { createEmailVerificationToken } = await import("better-auth/api");
const { db } = await import("../src/db/client");
const { env } = await import("../src/env");
const { member, organization, user } = await import("../src/db/auth-schema");

const auth = createAuthServer();
const routes = createSignupRoutes(auth);
const prefix = `open-signup-${crypto.randomUUID().slice(0, 8)}`;
const PASSWORD = "password-1234";
const CODE = "feedback-2026";

afterAll(async () => {
  for (const [name, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await db.delete(user).where(like(user.email, `${prefix}%`));
  await db.delete(organization).where(like(organization.slug, `${prefix}%`));
});

const address = (label: string, domain = "example.test") => `${prefix}-${label}@${domain}`;

function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(
    routes.fetch(
      new Request(BASE + path, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      { requestIP: () => ({ address: "127.0.0.1" }) },
    ),
  );
}
const signUp = (email: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  post("/api/auth/sign-up/email", { name: prefix, email, password: PASSWORD, inviteCode: CODE, ...extra }, headers);
const signIn = (email: string) =>
  auth.handler(
    new Request(`${BASE}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
async function openLink(email: string, account: string): Promise<Response> {
  const token = await createEmailVerificationToken(env.BETTER_AUTH_SECRET, email);
  const callbackURL = encodeURIComponent(`${env.FRONTEND_ORIGIN}/login?verified=1`);
  return routes.fetch(
    new Request(`${BASE}/api/auth/verify-email?token=${token}&callbackURL=${callbackURL}&account=${encodeURIComponent(account)}`),
  );
}
const row = async (email: string) => (await db.select().from(user).where(eq(user.email, email)))[0];
const memberships = (userId: string) => db.select().from(member).where(eq(member.userId, userId));
const sessionCookie = (res: Response) => res.headers.getSetCookie().some((cookie) => /session_token=[^;]/.test(cookie));

describe("open sign-up", () => {
  test("the card learns the shape of the policy, never the code", async () => {
    const res = await handleAuthRequest(new Request(`${BASE}/api/auth/provider-config`));
    expect(await res.json()).toMatchObject({ emailPassword: true, signup: { inviteCode: true, domains: ["example.test"] } });
    expect(JSON.stringify(await (await handleAuthRequest(new Request(`${BASE}/api/auth/provider-config`))).json())).not.toContain(CODE);
  });

  test("the policy answers before anything is looked up, the same for a stranger and an account", async () => {
    const outside = await signUp(address("outside", "other.test"));
    expect(outside.status).toBe(403);
    expect((await outside.json()).message).toBe("Sign-up is limited to @example.test addresses");
    expect(await row(address("outside", "other.test"))).toBeUndefined();

    const wrongCode = await signUp(address("known"), { inviteCode: "guess" });
    expect(wrongCode.status).toBe(403);
    expect((await wrongCode.json()).message).toBe("That invite code is not valid");

    expect((await signUp(address("known"))).status).toBe(200);
    const known = await row(address("known"));
    expect((await openLink(address("known"), known!.id)).status).toBe(302);
    const again = await signUp(address("known"), { inviteCode: "guess" });
    expect(again.status).toBe(403);
    expect((await again.json()).message).toBe("That invite code is not valid");
    // A verified account is never replaced or revealed: the library's generic answer.
    const duplicate = await signUp(address("known"));
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).token).toBeNull();
    expect(await row(address("known"))).toMatchObject({ id: known!.id, emailVerified: true });
  });

  test("the create hook is the gate whatever route creates the account", async () => {
    await expect(
      auth.api.signUpEmail({ body: { name: prefix, email: address("hook", "other.test"), password: PASSWORD, inviteCode: CODE } }),
    ).rejects.toThrow("Sign-up is limited to @example.test addresses");
    await expect(
      auth.api.signUpEmail({ body: { name: prefix, email: address("hook"), password: PASSWORD } }),
    ).rejects.toThrow("That invite code is not valid");
    expect(await row(address("hook"))).toBeUndefined();
  });

  test("a sign-up waits for its mail: no session, no organisation, no sign-in until the link is opened", async () => {
    const email = address("waits");
    const created = await signUp(email);
    expect(created.status).toBe(200);
    expect((await created.json()).token).toBeNull();
    expect(sessionCookie(created)).toBe(false);
    const pending = await row(email);
    expect(pending).toMatchObject({ emailVerified: false });
    expect(await memberships(pending!.id)).toEqual([]);

    const refused = await signIn(email);
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("EMAIL_NOT_VERIFIED");
    expect(sessionCookie(refused)).toBe(false);

    const verified = await openLink(email, pending!.id);
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe(`${env.FRONTEND_ORIGIN}/login?verified=1`);
    expect(await row(email)).toMatchObject({ id: pending!.id, emailVerified: true });
    expect(await memberships(pending!.id)).toHaveLength(1);

    const twice = await openLink(email, pending!.id);
    expect(twice.headers.get("location")).toBe(`${env.FRONTEND_ORIGIN}/login?verified=1`);
    expect(await memberships(pending!.id)).toHaveLength(1);

    const admitted = await signIn(email);
    expect(admitted.status).toBe(200);
    expect(sessionCookie(admitted)).toBe(true);
  });

  test("two clicks on the same link make one organisation", async () => {
    const email = address("double");
    expect((await signUp(email)).status).toBe(200);
    const pending = await row(email);
    const [a, b] = await Promise.all([openLink(email, pending!.id), openLink(email, pending!.id)]);
    expect([a.status, b.status]).toEqual([302, 302]);
    expect(await memberships(pending!.id)).toHaveLength(1);
  });

  test("a claim that never verified is replaced by the next sign-up and its link dies", async () => {
    const email = address("claim");
    expect((await signUp(email)).status).toBe(200);
    const first = await row(email);
    expect((await signUp(email)).status).toBe(200);
    const second = await row(email);
    expect(second!.id).not.toBe(first!.id);
    expect(await db.select().from(user).where(eq(user.id, first!.id))).toEqual([]);

    const stale = await openLink(email, first!.id);
    expect(stale.status).toBe(302);
    expect(stale.headers.get("location")).toBe(`${env.FRONTEND_ORIGIN}/login?error=signup_replaced`);
    expect(await row(email)).toMatchObject({ id: second!.id, emailVerified: false });

    expect((await openLink(email, second!.id)).headers.get("location")).toBe(`${env.FRONTEND_ORIGIN}/login?verified=1`);
    expect(await row(email)).toMatchObject({ id: second!.id, emailVerified: true });
  });

  test("an unverified account that already belongs somewhere is a person, not a claim", async () => {
    const email = address("member");
    const userId = `user_${crypto.randomUUID()}`;
    const orgId = `org_${crypto.randomUUID()}`;
    await db.insert(user).values({ id: userId, name: prefix, email, emailVerified: false });
    await db.insert(organization).values({ id: orgId, name: prefix, slug: `${prefix}-member`, createdAt: new Date() });
    await db.insert(member).values({ id: `member_${crypto.randomUUID()}`, organizationId: orgId, userId, role: "owner", createdAt: new Date() });
    const res = await signUp(email);
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBeNull();
    expect(await row(email)).toMatchObject({ id: userId });
  });

  test("nobody can have a link sent to an address they merely typed", async () => {
    expect((await post("/api/auth/send-verification-email", { email: address("waits") })).status).toBe(404);
  });

  test("with the switch off the closed rule stands, even on a server built while it was on", async () => {
    const before = { SIGNUP_OPEN: process.env.SIGNUP_OPEN, NODE_ENV: process.env.NODE_ENV };
    delete process.env.SIGNUP_OPEN;
    process.env.NODE_ENV = "production";
    try {
      const res = await signUp(address("closed"));
      expect(res.status).toBe(403);
      expect((await res.json()).message).toBe("Account creation is disabled");
    } finally {
      process.env.SIGNUP_OPEN = before.SIGNUP_OPEN;
      if (before.NODE_ENV === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before.NODE_ENV;
    }
    expect(await row(address("closed"))).toBeUndefined();
  });

  test("attempts are counted per address", async () => {
    const email = address("limited");
    for (let i = 0; i < SIGNUP_ATTEMPTS_PER_ADDRESS; i++) {
      expect((await signUp(email, { inviteCode: "guess" })).status).toBe(403);
    }
    const res = await signUp(email);
    expect(res.status).toBe(429);
    expect((await res.json()).message).toContain("Too many sign-up attempts");
    expect(await row(email)).toBeUndefined();
  });

  test("attempts are counted per client, and another client is not held back", async () => {
    let limited: Response | null = null;
    for (let i = 0; i < SIGNUP_ATTEMPTS_PER_CLIENT && !limited; i++) {
      const res = await signUp(address(`client-${i}`), { inviteCode: "guess" });
      if (res.status === 429) limited = res;
      else expect(res.status).toBe(403);
    }
    expect(limited?.status).toBe(429);
    const elsewhere = await signUp(address("elsewhere"), { inviteCode: "guess" }, { "x-forwarded-for": "203.0.113.9" });
    expect(elsewhere.status).toBe(403);
  });
});
