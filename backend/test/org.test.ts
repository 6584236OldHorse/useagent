import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../src/db/client";
import { member, organization, runs, user } from "../src/db/schema";
import { orgScope } from "../src/middleware/org";
import type { AppEnv } from "../src/http";
import { identityDirectory, type IdentityMembership, type IdentityOrganization, type IdentityProfile } from "../src/auth/clerk/directory";
import * as identityClientModule from "../src/auth/clerk/client";
import { createOrgSession, fetchApi, json } from "./helpers";

describe("org scoping", () => {
  test("dev fallback (no session) plants no demo skills at boot", async () => {
    // Boot no longer seeds template playbooks — the dev fallback org only ever
    // holds skills a caller explicitly creates, never fabricated demo data. So
    // the response is a valid list that never contains the old seed playbooks.
    const { status, body } = await json<{ skills: { name: string }[] }>(
      "/api/skills",
    );
    expect(status).toBe(200);
    expect(Array.isArray(body.skills)).toBe(true);
    const names = body.skills.map((s) => s.name);
    for (const demo of [
      "Ship a new page",
      "Fix flaky test",
      "Design review pass",
      "Port dashboard widget",
      "Write release notes",
      "Refactor to tokens",
      "Add API route",
    ]) {
      expect(names).not.toContain(demo);
    }
  });

  test("skills are org-scoped: an org sees only what it creates", async () => {
    // A brand-new user + org (real session, server-resolved tenancy).
    const { cookies } = await createOrgSession("acme");

    // A fresh org starts empty — nothing is seeded into it.
    const before = await json<{ skills: any[] }>("/api/skills", { cookies });
    expect(before.status).toBe(200);
    expect(before.body.skills.length).toBe(0);

    // Create one skill scoped to this org.
    const created = await json<{ id: string }>("/api/skills", {
      method: "POST",
      cookies,
      body: {
        name: "Acme-only playbook",
        description: "Fixture skill scoped to this org.",
        tags: ["review"],
        sections: { overview: ["step"], procedure: ["step"], verify: ["step"] },
      },
    });
    expect(created.status).toBe(201);

    // This org now sees exactly its own skill…
    const after = await json<{ skills: any[] }>("/api/skills", { cookies });
    expect(after.body.skills.length).toBe(1);

    // …and a second, independent org never sees it (tenancy isolation).
    const other = await createOrgSession("globex");
    const otherSkills = await json<{ skills: any[] }>("/api/skills", {
      cookies: other.cookies,
    });
    expect(otherSkills.status).toBe(200);
    expect(otherSkills.body.skills.length).toBe(0);
  });
});

describe("managed control-plane identity", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const profiles = new Map<string, IdentityProfile>();
  const memberships = new Map<string, IdentityMembership[]>();
  const remoteOrganizations = new Map<string, IdentityOrganization>();
  const actualUserProjection = identityDirectory.user;
  const actualOrganizationProjection = identityDirectory.organization;
  const envNames = ["AUTH", "ALLOW_DEV_ORG", "USEAGENT_DEV_MODE", "FRONTEND_ORIGIN", "GATEWAY_PUBLIC_URL", "CLERK_JWT_KEY", "CLERK_WEBHOOK_SECRET"] as const;
  let priorEnv: Record<string, string | undefined>;
  let prefix: string;
  let subject: string;
  let profile: IdentityProfile;
  let restore: Array<() => void>;
  let profileReads: number;
  let outbound: number;
  let membershipFailure: boolean;
  const app = new Hono<AppEnv>();
  app.get("/who", orgScope, (c) => c.json({ userId: c.get("userId"), orgId: c.get("orgId") }));

  beforeEach(() => {
    priorEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    process.env.AUTH = "clerk";
    process.env.ALLOW_DEV_ORG = "0";
    process.env.USEAGENT_DEV_MODE = "false";
    process.env.FRONTEND_ORIGIN = "http://localhost:3401";
    process.env.GATEWAY_PUBLIC_URL = "https://gateway.example.test";
    process.env.CLERK_JWT_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();
    process.env.CLERK_WEBHOOK_SECRET = `whsec_${Buffer.from("local-webhook-test-signing-secret").toString("base64")}`;
    prefix = `identity-${crypto.randomUUID()}`;
    subject = `user_${crypto.randomUUID()}`;
    profile = { id: subject, email: `member@${prefix}.test`, name: prefix, image: null, active: true, updatedAt: Date.now() };
    profiles.clear(); memberships.clear(); remoteOrganizations.clear();
    profiles.set(subject, profile);
    profileReads = 0; outbound = 0; membershipFailure = false; restore = [];
    const userLookup = spyOn(identityDirectory, "user").mockImplementation(async (id) => {
      profileReads++;
      const found = profiles.get(id);
      if (!found) throw Object.assign(new Error("missing"), { status: 404 });
      return found;
    });
    const organizationLookup = spyOn(identityDirectory, "organization").mockImplementation(async (id) => {
      const found = remoteOrganizations.get(id);
      if (!found) throw Object.assign(new Error("missing"), { status: 404 });
      return found;
    });
    const membershipList = spyOn(identityDirectory, "memberships").mockImplementation(async (id) => memberships.get(id) ?? []);
    const membershipLookup = spyOn(identityDirectory, "membership").mockImplementation(async (orgId, userId) => {
      if (membershipFailure) throw new Error("directory unavailable");
      return memberships.get(userId)?.find((item) => item.organization.id === orgId) ?? null;
    });
    const network = spyOn(globalThis, "fetch").mockImplementation(async () => {
      outbound++;
      throw new Error("network is forbidden in identity unit tests");
    });
    restore.push(() => userLookup.mockRestore(), () => organizationLookup.mockRestore(),
      () => membershipList.mockRestore(), () => membershipLookup.mockRestore(), () => network.mockRestore());
  });

  afterEach(async () => {
    for (const reset of restore) reset();
    for (const name of envNames) {
      if (priorEnv[name] === undefined) delete process.env[name];
      else process.env[name] = priorEnv[name];
    }
    await db.delete(runs).where(like(runs.id, `${prefix}%`));
    await db.delete(user).where(like(user.email, `%@${prefix}.test`));
    await db.delete(organization).where(like(organization.name, `${prefix}%`));
    expect(outbound).toBe(0);
  });

  function token(overrides: Record<string, unknown> = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "local-key" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: subject, sid: "sess_local", iss: "https://local.clerk.accounts.dev",
      azp: "http://localhost:3401", iat: now, nbf: now - 1, exp: now + 60, ...overrides })).toString("base64url");
    return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}`;
  }

  function who(value = token(), cookie = false): Promise<Response> {
    return app.request("/who", { headers: cookie ? { cookie: `__session=${value}` } : { authorization: `Bearer ${value}` } });
  }

  async function localOrganization() {
    const remote: IdentityOrganization = { id: `org_${crypto.randomUUID()}`, name: prefix, slug: `${prefix}-${crypto.randomUUID()}`,
      image: null, createdAt: Date.now(), createdBy: "user_existing_inviter" };
    remoteOrganizations.set(remote.id, remote);
    const [row] = await db.insert(organization).values({ id: `org_${crypto.randomUUID()}`, name: prefix,
      slug: remote.slug, clerkOrgId: remote.id, createdAt: new Date() }).returning();
    if (!row) throw new Error("fixture organization missing");
    return { local: row, remote };
  }

  async function localUser(linked = true, email = profile.email) {
    if (!email) throw new Error("fixture email missing");
    const [row] = await db.insert(user).values({ id: `${prefix}-${crypto.randomUUID()}`, name: prefix,
      email, emailVerified: true, clerkUserId: linked ? subject : null }).returning();
    if (!row) throw new Error("fixture user missing");
    return row;
  }

  async function join(userId: string, orgId: string) {
    await db.insert(member).values({ id: crypto.randomUUID(), userId, organizationId: orgId, role: "owner", createdAt: new Date() });
  }

  async function webhook(type: string, data: unknown, valid = true): Promise<Response> {
    const body = JSON.stringify({ type, object: "event", data });
    const messageId = `msg_${crypto.randomUUID()}`;
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", Buffer.from("local-webhook-test-signing-secret"))
      .update(`${messageId}.${timestamp}.${body}`).digest("base64");
    return fetchApi("/api/auth/clerk/webhook", { method: "POST", body, headers: {
      "svix-id": messageId, "svix-timestamp": timestamp, "svix-signature": `v1,${valid ? signature : "invalid"}`,
    } });
  }

  test("verifies cookies and bearer JWTs with a local key and preserves local identity", async () => {
    const local = await localUser();
    const org = await localOrganization();
    await join(local.id, org.local.id);
    for (const cookie of [true, false]) {
      const response = await who(token(), cookie);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ userId: local.id, orgId: org.local.id });
    }
    const response = await fetchApi("/api/auth/get-session", { cookies: `__session=${token()}` });
    expect(response.status).toBe(200);
    expect((await response.json()).user.id).toBe(local.id);
    expect(profileReads).toBe(0);
  });

  test("rejects expired, premature, foreign-origin, pending, and non-session tokens before profile lookup", async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const claims of [{ exp: now - 60 }, { nbf: now + 60 }, { azp: "https://other.invalid" }, { sts: "pending" }, { sid: null }]) {
      expect((await who(token(claims))).status).toBe(401);
    }
    expect((await who("not-a-jwt")).status).toBe(401);
    expect((await who("uak_not-a-session")).status).toBe(401);
    expect(profileReads).toBe(0);
  });

  test("links one verified primary email once without creating a replacement user or organization", async () => {
    const local = await localUser(false, `Member@${prefix}.test`);
    const org = await localOrganization();
    await join(local.id, org.local.id);
    const responses = await Promise.all([who(), who()]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect((await response.json()).userId).toBe(local.id);
    }
    expect(await db.select({ id: user.id }).from(user).where(eq(user.clerkUserId, subject))).toHaveLength(1);
    expect(await db.select({ id: member.id }).from(member).where(eq(member.userId, local.id))).toHaveLength(1);
    expect(profileReads).toBe(1);
  });

  test("denies unverified, conflicting, and ambiguous email links", async () => {
    const local = await localUser(false);
    profile.email = null;
    expect((await who()).status).toBe(403);
    profile.email = local.email;
    await db.update(user).set({ clerkUserId: "user_different" }).where(eq(user.id, local.id));
    expect((await who()).status).toBe(403);
    await db.update(user).set({ clerkUserId: null }).where(eq(user.id, local.id));
    await localUser(false, `Member@${prefix}.test`);
    expect((await who()).status).toBe(403);
  });

  test("the canonical profile uses only its verified primary email, never a secondary address", async () => {
    const remote = { id: subject, firstName: prefix, lastName: null, username: null, hasImage: false,
      banned: false, locked: false, updatedAt: Date.now(), primaryEmailAddressId: "primary",
      emailAddresses: [
        { id: "primary", emailAddress: `unverified@${prefix}.test`, verification: { status: "unverified" } },
        { id: "secondary", emailAddress: profile.email, verification: { status: "verified" } },
      ] };
    const client = spyOn(identityClientModule, "identityClient").mockReturnValue({
      users: { getUser: async () => remote },
    } as unknown as ReturnType<typeof identityClientModule.identityClient>);
    try {
      expect((await actualUserProjection(subject)).email).toBeNull();
      remote.primaryEmailAddressId = "secondary";
      expect((await actualUserProjection(subject)).email).toBe(profile.email);
      remote.id = "user_someone_else";
      await expect(actualUserProjection(subject)).rejects.toThrow("identity mismatch");
    } finally { client.mockRestore(); }
  });

  test("unknown users require self-signup or accepted membership in an existing organization", async () => {
    const refused = await who();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "no_organization" });
    expect((await webhook("user.created", { id: subject })).status).toBe(200);
    expect(await db.select().from(user).where(eq(user.clerkUserId, subject))).toHaveLength(0);
    const org = await localOrganization();
    memberships.set(subject, [{ userId: subject, organization: org.remote, role: "org:member" }]);
    const invited = await who(token({ org_id: org.remote.id }));
    expect(invited.status).toBe(200);
    expect((await invited.json()).orgId).toBe(org.local.id);
    const secondSubject = `user_${crypto.randomUUID()}`;
    profiles.set(secondSubject, { ...profile, id: secondSubject, email: `self@${prefix}.test` });
    process.env.USEAGENT_DEV_MODE = "true";
    const created = await who(token({ sub: secondSubject }));
    expect(created.status).toBe(200);
    expect((await created.json()).userId).not.toBe(secondSubject);
  });

  test("maps legacy and v2 active-org claims and never borrows a different membership", async () => {
    const local = await localUser();
    const allowed = await localOrganization();
    const foreign = await localOrganization();
    await join(local.id, allowed.local.id);
    for (const claims of [{ org_id: allowed.remote.id }, { o: { id: allowed.remote.id } }]) {
      const response = await who(token(claims));
      expect(response.status).toBe(200);
      expect((await response.json()).orgId).toBe(allowed.local.id);
    }
    for (const claims of [{ org_id: foreign.remote.id }, { org_id: "org_missing" }, { o: {} },
      { org_id: allowed.remote.id, o: { id: foreign.remote.id } }]) {
      expect((await who(token(claims))).status).toBe(403);
    }
  });

  test("zero local memberships stays forbidden for mapped and email-linked users", async () => {
    const local = await localUser();
    const org = await localOrganization();
    memberships.set(subject, [{ userId: subject, organization: org.remote, role: "org:admin" }]);
    expect((await who()).status).toBe(403);
    await db.update(user).set({ clerkUserId: null }).where(eq(user.id, local.id));
    expect((await who()).status).toBe(403);
    expect((await fetchApi("/api/auth/get-session", { cookies: `__session=${token()}` })).status).toBe(403);
  });

  test("default managed auth does not expose the legacy sign-up or organization-write lane", async () => {
    delete process.env.AUTH;
    expect((await fetchApi("/api/auth/organization/create", { method: "POST", body: {} })).status).toBe(404);
    expect((await fetchApi("/api/auth/sign-up/email", { method: "POST", body: {} })).status).toBe(404);
    const config = await fetchApi("/api/config");
    expect((await config.json()).auth).toBe("clerk");
    process.env.AUTH = "better-auth";
    const legacy = await fetchApi("/api/config");
    expect((await legacy.json()).auth).toBe("better-auth");
    expect((await fetchApi("/api/auth/provider-config")).status).toBe(200);
  });

  test("verifies the webhook signature before canonical reads and converges current membership on replay", async () => {
    const local = await localUser();
    const org = await localOrganization();
    const data = { id: "orgmem_fixture", organization: { id: org.remote.id }, public_user_data: { user_id: subject }, role: "org:admin" };
    memberships.set(subject, [{ userId: subject, organization: org.remote, role: "org:member" }]);
    expect((await webhook("organizationMembership.created", data, false)).status).toBe(400);
    expect(profileReads).toBe(0);
    expect((await webhook("organizationMembership.created", data)).status).toBe(200);
    const [first] = await db.select().from(member).where(eq(member.userId, local.id));
    expect(first?.role).toBe("member");
    expect((await webhook("organizationMembership.updated", data)).status).toBe(200);
    const unchanged = await db.select().from(member).where(eq(member.userId, local.id));
    expect(unchanged).toHaveLength(1);
    expect(unchanged[0]?.id).toBe(first?.id);
    membershipFailure = true;
    expect((await webhook("organizationMembership.deleted", data)).status).toBe(503);
    expect(await db.select().from(member).where(eq(member.userId, local.id))).toHaveLength(1);
    membershipFailure = false;
    memberships.set(subject, []);
    for (const type of ["organizationMembership.deleted", "organizationMembership.created", "organization_membership.updated"]) {
      expect((await webhook(type, data)).status).toBe(200);
      expect(await db.select().from(member).where(eq(member.userId, local.id))).toHaveLength(0);
    }
    memberships.set(subject, [{ userId: subject, organization: org.remote, role: "org:admin" }]);
    expect((await webhook("organizationMembership.deleted", data)).status).toBe(200);
    const [recreated] = await db.select().from(member).where(eq(member.userId, local.id));
    expect(recreated?.role).toBe("owner");
  });

  test("profile email conflicts cannot retain an owner role after a membership downgrade", async () => {
    const local = await localUser();
    const other = await localUser(false, `occupied@${prefix}.test`);
    const org = await localOrganization();
    await join(local.id, org.local.id);
    profile.email = other.email;
    memberships.set(subject, [{ userId: subject, organization: org.remote, role: "org:member" }]);
    expect((await webhook("organizationMembership.updated", { id: "orgmem_fixture",
      organization: { id: org.remote.id }, public_user_data: { user_id: subject } })).status).toBe(200);
    expect((await db.select().from(member).where(eq(member.userId, local.id)))[0]?.role).toBe("member");
    expect((await db.select().from(user).where(eq(user.id, local.id)))[0]?.email).toBe(local.email);
    expect((await db.select().from(user).where(eq(user.id, other.id)))[0]?.clerkUserId).toBeNull();
  });

  test("the auth rollback switch pauses webhook writes without acknowledging them", async () => {
    const local = await localUser();
    const org = await localOrganization();
    await join(local.id, org.local.id);
    process.env.AUTH = "better-auth";
    profiles.delete(subject);
    expect((await webhook("user.deleted", { id: subject })).status).toBe(503);
    expect(profileReads).toBe(0);
    expect(await db.select().from(member).where(eq(member.userId, local.id))).toHaveLength(1);
  });

  test("slugless managed organizations retain a stable local slug", async () => {
    await localUser();
    const remoteId = `org_${crypto.randomUUID()}`;
    const client = spyOn(identityClientModule, "identityClient").mockReturnValue({ organizations: {
      getOrganization: async () => ({ id: remoteId, name: prefix, slug: null, hasImage: false,
        createdAt: Date.now(), createdBy: subject }),
    } } as unknown as ReturnType<typeof identityClientModule.identityClient>);
    try {
      const projected = await actualOrganizationProjection(remoteId);
      expect(projected.slug).toBe(remoteId);
      remoteOrganizations.set(remoteId, projected);
      expect((await webhook("organization.created", { id: remoteId })).status).toBe(200);
      expect((await db.select().from(organization).where(eq(organization.clerkOrgId, remoteId)))[0]?.slug).toBe(remoteId);
    } finally { client.mockRestore(); }
  });

  test("user and organization deletion revoke access while preserving durable local identities", async () => {
    const local = await localUser();
    const org = await localOrganization();
    await join(local.id, org.local.id);
    const runId = `${prefix}-record`;
    await db.insert(runs).values({ id: runId, threadId: runId, orgId: org.local.id, userId: local.id,
      prompt: "identity preservation fixture", engine: "mock", model: "mock", status: "completed" });
    profile.name = `${prefix} Updated`;
    expect((await webhook("user.updated", { id: subject })).status).toBe(200);
    profiles.delete(subject);
    for (const type of ["user.deleted", "user.created", "user.deleted"]) {
      expect((await webhook(type, { id: subject })).status).toBe(200);
    }
    expect((await db.select().from(user).where(eq(user.id, local.id)))[0]?.clerkUserId).toBeNull();
    remoteOrganizations.delete(org.remote.id);
    for (const type of ["organization.deleted", "organization.updated", "organization.deleted"]) {
      expect((await webhook(type, { id: org.remote.id })).status).toBe(200);
    }
    expect((await db.select().from(organization).where(eq(organization.id, org.local.id)))[0]?.clerkOrgId).toBeNull();
    expect((await db.select().from(runs).where(eq(runs.id, runId)))[0]).toMatchObject({ userId: local.id, orgId: org.local.id });
  });
});
