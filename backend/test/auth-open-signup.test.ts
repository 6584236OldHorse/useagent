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
  GOOGLE_CLIENT_ID: "google-test-client",
  GOOGLE_CLIENT_SECRET: "google-test-secret",
};
const prior = Object.fromEntries(Object.keys(OPEN).map((name) => [name, process.env[name]]));
const { BASE, ORIGIN } = await import("./helpers");
Object.assign(process.env, OPEN);
const { createAuthServer } = await import("../src/auth");
const { handleAuthRequest } = await import("../src/auth/routes");
const { SIGNUP_ATTEMPTS_PER_ADDRESS, SIGNUP_ATTEMPTS_PER_CLIENT, createSignupRoutes, fixedWindow } = await import("../src/auth/signup-routes");
const { CONFIRMATION_TTL_MS, confirmationToken } = await import("../src/auth-invitations");
const { db } = await import("../src/db/client");
const { env } = await import("../src/env");
const { account, member, organization, user } = await import("../src/db/auth-schema");
const { slackAccessRequests, slackWorkspaces } = await import("../src/db/schema");
const { decideAccessRequest } = await import("../src/slack/access-requests");
const { setSlackClientForTest } = await import("../src/slack");

const auth = createAuthServer();
const routes = createSignupRoutes(auth);
// A Google identity whose verified address is the token itself.
const google = (await auth.$context).socialProviders.find((provider) => provider.id === "google");
if (!google) throw new Error("Google test provider missing");
google.verifyIdToken = async () => true;
google.getUserInfo = async ({ idToken }) => ({ user: { id: `google-${idToken}`, email: idToken, emailVerified: true, name: idToken } });
const prefix = `open-signup-${crypto.randomUUID().slice(0, 8)}`;
const PASSWORD = "password-1234";
const CODE = "feedback-2026";
const teamId = `T-${prefix}`;

afterAll(async () => {
  for (const [name, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await db.delete(slackWorkspaces).where(eq(slackWorkspaces.teamId, teamId));
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
const confirm = (token: string) => routes.fetch(new Request(`${BASE}/api/auth/confirm-signup?token=${encodeURIComponent(token)}`));
const openLink = (email: string, account: string, at = Date.now()) =>
  confirm(confirmationToken({ id: account, email }, env.BETTER_AUTH_SECRET, at));
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

    // However often the card asks again, the newest link is the one that works.
    const again = address("again");
    for (let i = 0; i < 3; i++) expect((await signUp(again)).status).toBe(200);
    const latest = await row(again);
    expect((await openLink(again, latest!.id)).headers.get("location")).toBe(`${env.FRONTEND_ORIGIN}/login?verified=1`);
  });

  test("a request the library refuses changes nothing: the pending registration and its link stay", async () => {
    const email = address("kept");
    expect((await signUp(email)).status).toBe(200);
    const pending = await row(email);
    // The library's own rules (a password too short here; its origin rule is off under test) answer first.
    const short = await signUp(email, { password: "short" });
    expect(short.status).toBe(400);
    expect(await row(email)).toMatchObject({ id: pending!.id, emailVerified: false });
    expect((await openLink(email, pending!.id)).headers.get("location")).toBe(`${env.FRONTEND_ORIGIN}/login?verified=1`);
  });

  test("a link is judged by its signature before anything is looked up", async () => {
    const known = address("waits"); // confirmed above
    const pending = await row(known);
    const forged = (email: string, id: string) => {
      const [payload] = confirmationToken({ id, email }).split(".");
      return confirm(`${payload}.${confirmationToken({ id: "someone", email: "else@example.test" }).split(".")[1]}`);
    };
    for (const res of [await forged(known, pending!.id), await forged(address("nobody"), "user_none")]) {
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(`${env.FRONTEND_ORIGIN}/login?error=link_invalid`);
    }
    const expired = await openLink(known, pending!.id, Date.now() - CONFIRMATION_TTL_MS - 1000);
    expect(expired.headers.get("location")).toBe(`${env.FRONTEND_ORIGIN}/login?error=link_expired`);
    // The library's own route, keyed by the address alone, is closed.
    expect((await routes.fetch(new Request(`${BASE}/api/auth/verify-email?token=x`))).status).toBe(404);
  });

  test("only a JSON body passes the door, whatever the address", async () => {
    const form = (email: string) =>
      routes.fetch(
        new Request(`${BASE}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ name: prefix, email, password: PASSWORD, inviteCode: "guess" }).toString(),
        }),
        { requestIP: () => ({ address: "127.0.0.1" }) },
      );
    for (const res of [await form(address("waits")), await form(address("form-new"))]) {
      expect(res.status).toBe(400);
      expect((await res.json()).message).toBe("Send the sign-up as JSON");
    }
    expect(await row(address("form-new"))).toBeUndefined();
    expect((await signUp(address("form-new"), { email: 5 })).status).toBe(400);
  });

  test("closing sign-up after a claim was made does not let its password in", async () => {
    const email = address("closed-later");
    expect((await signUp(email)).status).toBe(200);
    const before = { SIGNUP_OPEN: process.env.SIGNUP_OPEN, NODE_ENV: process.env.NODE_ENV, BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET };
    delete process.env.SIGNUP_OPEN;
    process.env.NODE_ENV = "production";
    process.env.BETTER_AUTH_SECRET = "closed-signup-test-secret-0123456789abcdef";
    try {
      const closed = createAuthServer(); // a restart with the switch off
      expect(closed.options.emailAndPassword).toMatchObject({ disableSignUp: true, requireEmailVerification: false });
      const refused = await closed.handler(
        new Request(`${BASE}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ email, password: PASSWORD }),
        }),
      );
      expect(refused.status).toBe(403);
      expect((await refused.json()).code).toBe("EMAIL_NOT_VERIFIED");
      expect(sessionCookie(refused)).toBe(false);
    } finally {
      process.env.SIGNUP_OPEN = before.SIGNUP_OPEN;
      for (const name of ["NODE_ENV", "BETTER_AUTH_SECRET"] as const) {
        if (before[name] === undefined) delete process.env[name];
        else process.env[name] = before[name];
      }
    }
    expect(await row(email)).toMatchObject({ emailVerified: false });
  });

  test("Slack admission releases a claim on the address instead of adopting it", async () => {
    const email = address("slack");
    expect((await signUp(email)).status).toBe(200); // a stranger's claim, password included
    const claim = await row(email);
    const orgId = `org_${crypto.randomUUID()}`;
    await db.insert(organization).values({ id: orgId, name: prefix, slug: `${prefix}-slack`, createdAt: new Date() });
    await db.insert(slackWorkspaces).values({ teamId, orgId, userId: "user_slack_operator" });
    const requestId = crypto.randomUUID();
    await db.insert(slackAccessRequests).values({ id: requestId, teamId, slackUserId: "U-OWNER", orgId, name: "Owner", email, status: "pending" });
    setSlackClientForTest({ postMessage: async () => ({ ok: true }) } as unknown as Parameters<typeof setSlackClientForTest>[0]);
    try {
      const decision = await decideAccessRequest({ id: requestId, orgId, decidedBy: { id: "user_admin", name: "Admin", email: "admin@example.test" }, allow: true });
      expect(decision.outcome).toBe("allowed");
    } finally {
      setSlackClientForTest(null);
    }
    const admitted = await row(email);
    expect(admitted).toMatchObject({ emailVerified: false });
    expect(admitted!.id).not.toBe(claim!.id);
    expect(await db.select().from(account).where(eq(account.userId, claim!.id))).toEqual([]); // the stranger's password is gone
    expect((await memberships(admitted!.id)).map((row) => row.organizationId)).toContain(orgId);
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

  test("a provider identity never links to a claim, and still links to a confirmed account", async () => {
    const email = address("google-claim");
    expect((await signUp(email)).status).toBe(200);
    const claim = await row(email);
    await expect(auth.api.signInSocial({ body: { provider: "google", idToken: { token: email } } })).rejects.toThrow(/link/);
    expect(await row(email)).toMatchObject({ id: claim!.id, emailVerified: false });
    expect(await db.select().from(account).where(eq(account.userId, claim!.id))).toHaveLength(1); // the password only

    const confirmed = address("waits"); // confirmed above
    const linked = await auth.api.signInSocial({ body: { provider: "google", idToken: { token: confirmed } } });
    expect(linked.user.email).toBe(confirmed);
    expect(await db.select().from(account).where(eq(account.userId, linked.user.id))).toHaveLength(2);
  });

  test("a fixed window counts attempts per key and starts over once it has passed", () => {
    const allow = fixedWindow(2, 50);
    expect([allow("a"), allow("a"), allow("a"), allow("b")]).toEqual([true, true, false, true]);
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
    const client = { "x-forwarded-for": "198.51.100.7" }; // its own client, so this file's shared client budget is untouched
    for (let i = 0; i < SIGNUP_ATTEMPTS_PER_ADDRESS; i++) {
      expect((await signUp(email, { inviteCode: "guess" }, client)).status).toBe(403);
    }
    const res = await signUp(email, {}, client);
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
