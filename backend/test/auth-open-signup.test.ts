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
const { SIGNUP_ATTEMPTS_PER_ADDRESS, SIGNUP_ATTEMPTS_PER_CLIENT, SIGN_IN_CONFIRMATION_MAILS_PER_ADDRESS, createSignupRoutes, fixedWindow } =
  await import("../src/auth/signup-routes");
const { CONFIRMATION_TTL_MS, confirmationToken } = await import("../src/auth-invitations");
const { db } = await import("../src/db/client");
const { env } = await import("../src/env");
const { account, invitation, member, organization, user } = await import("../src/db/auth-schema");
const { slackAccessRequests, slackWorkspaces } = await import("../src/db/schema");
const { decideAccessRequest } = await import("../src/slack/access-requests");
const { setSlackClientForTest } = await import("../src/slack");

type Server = ReturnType<typeof createAuthServer>;
type Routes = ReturnType<typeof createSignupRoutes>;

/** A Google identity whose verified address is the token itself. */
async function stubGoogle(server: Server): Promise<void> {
  const google = (await server.$context).socialProviders.find((provider) => provider.id === "google");
  if (!google) throw new Error("Google test provider missing");
  google.verifyIdToken = async () => true;
  google.getUserInfo = async ({ idToken }) => ({ user: { id: `google-${idToken}`, email: idToken, emailVerified: true, name: idToken } });
}

const auth = createAuthServer();
const routes = createSignupRoutes(auth);
await stubGoogle(auth);

const prefix = `open-signup-${crypto.randomUUID().slice(0, 8)}`;
const PASSWORD = "password-1234";
const CODE = "feedback-2026";
const teamIds = [`T-${prefix}-a`, `T-${prefix}-b`] as const;

/** Run with the environment a restarted production backend would have: the
 *  switch as given, the library's own limiter on. Restored afterwards. */
async function inProduction<T>(open: boolean, work: () => Promise<T>): Promise<T> {
  const before = { SIGNUP_OPEN: process.env.SIGNUP_OPEN, NODE_ENV: process.env.NODE_ENV, BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET };
  if (!open) delete process.env.SIGNUP_OPEN;
  process.env.NODE_ENV = "production";
  process.env.BETTER_AUTH_SECRET = "restart-test-secret-0123456789abcdef";
  try {
    return await work();
  } finally {
    for (const name of ["SIGNUP_OPEN", "NODE_ENV", "BETTER_AUTH_SECRET"] as const) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  }
}

afterAll(async () => {
  for (const [name, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const teamId of teamIds) await db.delete(slackWorkspaces).where(eq(slackWorkspaces.teamId, teamId));
  await db.delete(user).where(like(user.email, `${prefix}%`));
  await db.delete(organization).where(like(organization.slug, `${prefix}%`));
});

const address = (label: string, domain = "example.test") => `${prefix}-${label}@${domain}`;
/** A client of its own, so a test's attempts do not eat this file's shared client budget. */
const own = (n: number) => ({ "x-forwarded-for": `203.0.113.${n}` });

function postTo(target: Routes, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(
    target.fetch(
      new Request(BASE + path, {
        method: "POST",
        headers: { origin: ORIGIN, "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      }),
      { requestIP: () => ({ address: "127.0.0.1" }) },
    ),
  );
}
const post = (path: string, body: unknown, headers?: Record<string, string>) => postTo(routes, path, body, headers);
const signUpWith = (target: Routes, email: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>) =>
  postTo(target, "/api/auth/sign-up/email", { name: prefix, email, password: PASSWORD, inviteCode: CODE, ...extra }, headers);
const signUp = (email: string, extra: Record<string, unknown> = {}, headers?: Record<string, string>) => signUpWith(routes, email, extra, headers);
const signInWith = (target: Routes, email: string, headers?: Record<string, string>) =>
  postTo(target, "/api/auth/sign-in/email", { email, password: PASSWORD }, headers);
const signIn = (email: string) => signInWith(routes, email);
const confirmWith = (target: Routes, token: string) =>
  target.fetch(new Request(`${BASE}/api/auth/confirm-signup?token=${encodeURIComponent(token)}`));
const openLinkWith = (target: Routes, email: string, id: string, at = Date.now()) =>
  confirmWith(target, confirmationToken({ id, email }, env.BETTER_AUTH_SECRET, at));
const openLink = (email: string, id: string, at = Date.now()) => openLinkWith(routes, email, id, at);
const declineLink = (email: string, id: string) =>
  routes.fetch(new Request(`${BASE}/api/auth/decline-signup?token=${encodeURIComponent(confirmationToken({ id, email }))}`));
const row = async (email: string) => (await db.select().from(user).where(eq(user.email, email)))[0];
const memberships = (userId: string) => db.select().from(member).where(eq(member.userId, userId));
const accounts = (userId: string) => db.select().from(account).where(eq(account.userId, userId));
const sessionCookie = (res: Response) => res.headers.getSetCookie().some((cookie) => /session_token=[^;]/.test(cookie));
const landing = (res: Response) => res.headers.get("location");
const verifiedAt = `${env.FRONTEND_ORIGIN}/login?verified=1`;
const replacedAt = `${env.FRONTEND_ORIGIN}/login?error=signup_replaced`;

/** An organisation of this file's, with an owner who can invite. */
async function organisation(label: string): Promise<{ orgId: string; inviterId: string }> {
  const orgId = `org_${crypto.randomUUID()}`;
  const inviterId = `user_${crypto.randomUUID()}`;
  await db.insert(user).values({ id: inviterId, name: prefix, email: address(`inviter-${label}`), emailVerified: true });
  await db.insert(organization).values({ id: orgId, name: prefix, slug: `${prefix}-${label}`, createdAt: new Date() });
  await db.insert(member).values({ id: `member_${crypto.randomUUID()}`, organizationId: orgId, userId: inviterId, role: "owner", createdAt: new Date() });
  return { orgId, inviterId };
}
async function invite(orgId: string, inviterId: string, email: string): Promise<void> {
  await db.insert(invitation).values({
    id: `inv_${crypto.randomUUID()}`,
    organizationId: orgId,
    email,
    role: "member",
    status: "pending",
    expiresAt: new Date(Date.now() + 86_400_000),
    inviterId,
  });
}
/** An admin lets a Slack sender with this address into the organisation. The
 *  Slack transport is a recording stub: nothing reaches Slack. */
async function admitFromSlack(teamId: string, orgId: string, email: string): Promise<string> {
  await db.insert(slackWorkspaces).values({ teamId, orgId, userId: "user_slack_operator" }).onConflictDoNothing();
  const requestId = crypto.randomUUID();
  await db.insert(slackAccessRequests).values({ id: requestId, teamId, slackUserId: `U-${requestId.slice(0, 8)}`, orgId, name: "Owner", email, status: "pending" });
  setSlackClientForTest({ postMessage: async () => ({ ok: true }) } as unknown as Parameters<typeof setSlackClientForTest>[0]);
  try {
    const decision = await decideAccessRequest({ id: requestId, orgId, decidedBy: { id: "user_admin", name: "Admin", email: "admin@example.test" }, allow: true });
    return decision.outcome;
  } finally {
    setSlackClientForTest(null);
  }
}

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
    // A confirmed account is never replaced or revealed: the library's generic answer.
    const duplicate = await signUp(address("known"));
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).token).toBeNull();
    expect(await row(address("known"))).toMatchObject({ id: known!.id, emailVerified: true });
  });

  test("the create hook is the gate whatever route creates the account", async () => {
    await expect(
      auth.api.signUpEmail({ body: { name: prefix, email: address("hook", "other.test"), password: PASSWORD, inviteCode: CODE } }),
    ).rejects.toThrow("Sign-up is limited to @example.test addresses");
    await expect(auth.api.signUpEmail({ body: { name: prefix, email: address("hook"), password: PASSWORD } })).rejects.toThrow(
      "That invite code is not valid",
    );
    expect(await row(address("hook"))).toBeUndefined();
  });

  test("an invited address passes the domain rule and the code", async () => {
    const { orgId, inviterId } = await organisation("invites");
    const email = address("guest", "other.test");
    expect((await signUp(email, { inviteCode: "" })).status).toBe(403);
    await invite(orgId, inviterId, email);
    expect((await signUp(email, { inviteCode: "" })).status).toBe(200);
    expect(await row(email)).toMatchObject({ emailVerified: false });
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
    expect(await refused.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED", mail: { sent: true } });
    expect(sessionCookie(refused)).toBe(false);

    const verified = await openLink(email, pending!.id);
    expect(verified.status).toBe(302);
    expect(landing(verified)).toBe(verifiedAt);
    expect(await row(email)).toMatchObject({ id: pending!.id, emailVerified: true });
    expect(await memberships(pending!.id)).toHaveLength(1);

    expect(landing(await openLink(email, pending!.id))).toBe(verifiedAt);
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
    expect(landing(stale)).toBe(replacedAt);
    expect(await row(email)).toMatchObject({ id: second!.id, emailVerified: false });

    expect(landing(await openLink(email, second!.id))).toBe(verifiedAt);
    expect(await row(email)).toMatchObject({ id: second!.id, emailVerified: true });

    // However often the card asks again, the newest link is the one that works.
    const again = address("again");
    for (let i = 0; i < 3; i++) expect((await signUp(again, {}, own(21))).status).toBe(200);
    const latest = await row(again);
    expect(landing(await openLink(again, latest!.id))).toBe(verifiedAt);
  });

  test("a request the library refuses changes nothing: the pending registration and its link stay", async () => {
    const email = address("kept");
    expect((await signUp(email)).status).toBe(200);
    const pending = await row(email);
    // The library's own rules (a password too short here; its origin rule is off under test) answer first.
    const short = await signUp(email, { password: "short" });
    expect(short.status).toBe(400);
    expect(await row(email)).toMatchObject({ id: pending!.id, emailVerified: false });
    expect(landing(await openLink(email, pending!.id))).toBe(verifiedAt);
  });

  test("the library's own limiter cannot cost a claim: one library call per attempt, the claim set aside only until the answer", async () => {
    const production = await inProduction(true, async () => createAuthServer());
    const target = createSignupRoutes(production);
    const email = address("slots");
    const client = own(77);
    expect((await signUpWith(target, email, {}, client)).status).toBe(200);
    const first = await row(email);
    expect((await signUpWith(target, email, { password: "short" }, client)).status).toBe(400);
    expect(await row(email)).toMatchObject({ id: first!.id });
    expect((await signUpWith(target, email, {}, client)).status).toBe(200);
    const second = await row(email);
    expect(second!.id).not.toBe(first!.id);
    // The library's fourth call within ten seconds is refused by its limiter;
    // the registration the attempt would have replaced is untouched.
    const refused = await signUpWith(target, email, {}, client);
    expect(refused.status).toBe(429);
    expect(await row(email)).toMatchObject({ id: second!.id, emailVerified: false });
    expect(landing(await openLinkWith(target, email, second!.id))).toBe(verifiedAt);
  });

  test("Slack admission releases a claim instead of adopting it, and the person gets both workspaces", async () => {
    const email = address("slack");
    expect((await signUp(email)).status).toBe(200); // a stranger's claim, password included
    const claim = await row(email);
    const { orgId } = await organisation("slack");
    expect(await admitFromSlack(teamIds[0], orgId, email)).toBe("allowed");
    const admitted = await row(email);
    expect(admitted).toMatchObject({ emailVerified: false });
    expect(admitted!.id).not.toBe(claim!.id);
    expect(await accounts(claim!.id)).toEqual([]); // the stranger's password is gone
    const orgs = (await memberships(admitted!.id)).map((membership) => membership.organizationId);
    expect(orgs).toContain(orgId);
    expect(orgs).toHaveLength(2); // the Slack workspace and one of their own
    expect(landing(await openLink(email, claim!.id))).toBe(replacedAt);
  });

  test("confirmed first, then admitted from Slack: the same person, both workspaces", async () => {
    const email = address("slack-after");
    expect((await signUp(email)).status).toBe(200);
    const pending = await row(email);
    expect(landing(await openLink(email, pending!.id))).toBe(verifiedAt);
    expect(await memberships(pending!.id)).toHaveLength(1);
    const { orgId } = await organisation("slack-after");
    expect(await admitFromSlack(teamIds[1], orgId, email)).toBe("allowed");
    expect(await row(email)).toMatchObject({ id: pending!.id, emailVerified: true });
    const orgs = (await memberships(pending!.id)).map((membership) => membership.organizationId);
    expect(orgs).toContain(orgId);
    expect(orgs).toHaveLength(2);
  });

  test("a provider identity that verified the address takes over a claim: its password goes, invited or not, open or closed", async () => {
    // Open, no invitation: the account exists already, no door is opened.
    const openEmail = address("takeover-open");
    expect((await signUp(openEmail, {}, own(31))).status).toBe(200);
    const openClaim = await row(openEmail);
    const linked = await auth.api.signInSocial({ body: { provider: "google", idToken: { token: openEmail } } });
    expect(linked.user.id).toBe(openClaim!.id);
    expect(await row(openEmail)).toMatchObject({ emailVerified: true });
    expect((await accounts(openClaim!.id)).map((linkedAccount) => linkedAccount.providerId)).toEqual(["google"]);
    expect(await memberships(openClaim!.id)).toHaveLength(1);
    expect((await signIn(openEmail)).status).toBe(401); // the password the claim chose opens nothing now

    // Closed after the claim was made and the owner invited: the link path lets them through.
    const closedEmail = address("takeover-closed");
    expect((await signUp(closedEmail, {}, own(32))).status).toBe(200);
    const closedClaim = await row(closedEmail);
    const { orgId, inviterId } = await organisation("takeover");
    await invite(orgId, inviterId, closedEmail);
    await inProduction(false, async () => {
      const closed = createAuthServer();
      await stubGoogle(closed);
      const admitted = await closed.api.signInSocial({ body: { provider: "google", idToken: { token: closedEmail } } });
      expect(admitted.user.id).toBe(closedClaim!.id);
    });
    expect(await row(closedEmail)).toMatchObject({ id: closedClaim!.id, emailVerified: true });
    expect((await accounts(closedClaim!.id)).map((linkedAccount) => linkedAccount.providerId)).toEqual(["google"]);
    expect(await memberships(closedClaim!.id)).toHaveLength(1);
  });

  test("a link is judged by its signature before anything is looked up", async () => {
    const known = address("waits"); // confirmed above
    const pending = await row(known);
    const forged = (email: string, id: string) => {
      const [payload] = confirmationToken({ id, email }).split(".");
      return confirmWith(routes, `${payload}.${confirmationToken({ id: "someone", email: "else@example.test" }).split(".")[1]}`);
    };
    for (const res of [await forged(known, pending!.id), await forged(address("nobody"), "user_none")]) {
      expect(res.status).toBe(302);
      expect(landing(res)).toBe(`${env.FRONTEND_ORIGIN}/login?error=link_invalid`);
    }
    const expired = await openLink(known, pending!.id, Date.now() - CONFIRMATION_TTL_MS - 1000);
    expect(landing(expired)).toBe(`${env.FRONTEND_ORIGIN}/login?error=link_expired`);
    // The library's own route, keyed by the address alone, is closed.
    expect((await routes.fetch(new Request(`${BASE}/api/auth/verify-email?token=x`))).status).toBe(404);
  });

  test("the mail's cancel link removes a claim, and only a claim", async () => {
    const email = address("declined");
    expect((await signUp(email, {}, own(41))).status).toBe(200);
    const claim = await row(email);
    expect(landing(await declineLink(email, claim!.id))).toBe(`${env.FRONTEND_ORIGIN}/login?declined=1`);
    expect(await row(email)).toBeUndefined();
    // A confirmed account is not a claim: its cancel link does nothing to it.
    const kept = address("waits");
    const person = await row(kept);
    expect(landing(await declineLink(kept, person!.id))).toBe(`${env.FRONTEND_ORIGIN}/login?declined=1`);
    expect(await row(kept)).toMatchObject({ id: person!.id, emailVerified: true });
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

  test("closing sign-up after a claim was made does not let its password in, and says so", async () => {
    const email = address("closed-later");
    expect((await signUp(email, {}, own(51))).status).toBe(200);
    await inProduction(false, async () => {
      const closed = createAuthServer(); // a restart with the switch off
      expect(closed.options.emailAndPassword).toMatchObject({ disableSignUp: true, requireEmailVerification: false });
      const refused = await signInWith(createSignupRoutes(closed), email, own(51));
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED", mail: { sent: false, reason: "closed" } });
      expect(sessionCookie(refused)).toBe(false);
    });
    expect(await row(email)).toMatchObject({ emailVerified: false });
  });

  test("a sign-in with the right password says whether the link went out again", async () => {
    const email = address("mail-truth");
    expect((await signUp(email, {}, own(61))).status).toBe(200);
    for (let i = 0; i < SIGN_IN_CONFIRMATION_MAILS_PER_ADDRESS; i++) {
      const res = await signIn(email);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED", mail: { sent: true } });
    }
    const held = await signIn(email);
    expect(held.status).toBe(403);
    const answer = (await held.json()) as { mail: { sent: boolean; reason?: string; retryAfterSeconds?: number } };
    expect(answer).toMatchObject({ code: "EMAIL_NOT_VERIFIED", mail: { sent: false, reason: "held" } });
    expect(answer.mail.retryAfterSeconds).toBeGreaterThan(0);
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

  test("a fixed window admits up to its count per key and says how long to wait", () => {
    const wait = fixedWindow(2, 50_000);
    expect([wait("a"), wait("a")]).toEqual([0, 0]);
    expect(wait("a")).toBeGreaterThan(0);
    expect(wait("b")).toBe(0);
  });

  test("nobody can have a link sent to an address they merely typed", async () => {
    expect((await post("/api/auth/send-verification-email", { email: address("waits") })).status).toBe(404);
  });

  test("attempts are counted per address", async () => {
    const email = address("limited");
    const client = own(7);
    for (let i = 0; i < SIGNUP_ATTEMPTS_PER_ADDRESS; i++) {
      expect((await signUp(email, { inviteCode: "guess" }, client)).status).toBe(403);
    }
    const res = await signUp(email, {}, client);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
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
    const elsewhere = await signUp(address("elsewhere"), { inviteCode: "guess" }, own(9));
    expect(elsewhere.status).toBe(403);
  });
});
