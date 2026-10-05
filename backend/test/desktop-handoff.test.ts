import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import * as identityClientModule from "../src/auth/clerk/client";
import { db } from "../src/db/client";
import { member, organization, user, verification } from "../src/db/schema";
import { fetchApi } from "./helpers";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const origin = "http://localhost:3401";
const prefix = "desktop-handoff:";
const encoded = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");

describe("desktop identity handoff", () => {
  const envNames = ["AUTH", "ALLOW_DEV_ORG", "USEAGENT_DEV_MODE", "FRONTEND_ORIGIN", "CLERK_JWT_KEY"] as const;
  let priorEnv: Record<string, string | undefined>;
  let localUserId: string;
  let localOrgId: string;
  let clerkUserId: string;
  let clerkOrgId: string;
  let cookie: string;
  let mint: ReturnType<typeof spyOn>;
  let ticketRequests: unknown[];

  beforeEach(async () => {
    priorEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    process.env.AUTH = "clerk";
    process.env.ALLOW_DEV_ORG = "0";
    process.env.USEAGENT_DEV_MODE = "false";
    process.env.FRONTEND_ORIGIN = origin;
    process.env.CLERK_JWT_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();

    localUserId = `desktop-user-${crypto.randomUUID()}`;
    localOrgId = `desktop-org-${crypto.randomUUID()}`;
    clerkUserId = `user_${crypto.randomUUID()}`;
    clerkOrgId = `org_${crypto.randomUUID()}`;
    await db.insert(user).values({ id: localUserId, clerkUserId, name: "Desktop user", email: `${localUserId}@test.invalid` });
    await db.insert(organization).values({ id: localOrgId, clerkOrgId, name: localOrgId, slug: localOrgId, createdAt: new Date() });
    await db.insert(member).values({ id: crypto.randomUUID(), userId: localUserId, organizationId: localOrgId, role: "owner", createdAt: new Date() });

    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "local-key" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: clerkUserId, sid: "sess_desktop", org_id: clerkOrgId,
      iss: "https://local.clerk.accounts.dev", azp: origin, iat: now, nbf: now - 1, exp: now + 60 })).toString("base64url");
    cookie = `__session=${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}`;
    ticketRequests = [];
    mint = spyOn(identityClientModule, "identityClient").mockReturnValue({ signInTokens: {
      createSignInToken: async (input: unknown) => {
        ticketRequests.push(input);
        return { token: "ticket_fixture" };
      },
    } } as unknown as ReturnType<typeof identityClientModule.identityClient>);
  });

  afterEach(async () => {
    mint.mockRestore();
    await db.delete(verification).where(sql`${verification.identifier} like ${`${prefix}%`}`);
    await db.delete(member).where(eq(member.userId, localUserId));
    await db.delete(organization).where(eq(organization.id, localOrgId));
    await db.delete(user).where(eq(user.id, localUserId));
    for (const name of envNames) {
      if (priorEnv[name] === undefined) delete process.env[name];
      else process.env[name] = priorEnv[name];
    }
  });

  async function complete(state = encoded(), verifier = encoded()) {
    const challenge = hash(verifier);
    const response = await fetchApi("/api/auth/desktop/complete", {
      method: "POST", cookies: cookie, headers: { origin }, body: { state, challenge },
    });
    const result = await response.json() as { url: string };
    return { response, state, verifier, code: new URL(result.url).searchParams.get("code")!, url: result.url };
  }

  function exchange(code: string, state: string, verifier: string, headers: Record<string, string> = {}) {
    return fetchApi("/api/auth/desktop/exchange", {
      method: "POST", headers: { origin: "", ...headers }, body: { code, state, verifier },
    });
  }

  test("mints a one-use ticket from server-resolved Clerk identities", async () => {
    const created = await complete();
    expect(created.response.status).toBe(200);
    expect(created.url).not.toContain("ticket");
    expect(created.code).toHaveLength(43);
    const [stored] = await db.select().from(verification)
      .where(eq(verification.identifier, `${prefix}${hash(created.code)}`));
    expect(stored?.value).toContain(created.state);
    expect(stored?.value).not.toContain(created.code);

    const response = await exchange(created.code, created.state, created.verifier);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ticket: "ticket_fixture" });
    expect(ticketRequests).toEqual([{ userId: clerkUserId, orgId: clerkOrgId, expiresInSeconds: 60 }]);
    expect((await exchange(created.code, created.state, created.verifier)).status).toBe(400);
  });

  test("complete requires a Clerk session, trusted origin, and exact PKCE values", async () => {
    const state = encoded();
    const challenge = encoded();
    expect((await fetchApi("/api/auth/desktop/complete", { method: "POST", headers: { origin }, body: { state, challenge } })).status).toBe(401);
    expect((await fetchApi("/api/auth/desktop/complete", { method: "POST",
      headers: { origin, authorization: `Bearer ${cookie.slice("__session=".length)}` }, body: { state, challenge } })).status).toBe(401);
    expect((await fetchApi("/api/auth/desktop/complete", { method: "POST", cookies: cookie,
      headers: { origin: "https://attacker.invalid" }, body: { state, challenge } })).status).toBe(403);
    expect((await fetchApi("/api/auth/desktop/complete", { method: "POST", cookies: cookie,
      headers: { origin }, body: { state: `${state}x`, challenge } })).status).toBe(400);
    expect((await fetchApi("/api/auth/desktop/complete", { method: "POST", cookies: cookie,
      headers: { origin, authorization: "Bearer uak_invalid" }, body: { state, challenge } })).status).toBe(401);
    expect((await exchange(encoded(), encoded(), encoded(), { origin: "https://attacker.invalid" })).status).toBe(403);
    process.env.AUTH = "better-auth";
    expect((await fetchApi("/api/auth/desktop/complete", { method: "POST", cookies: cookie,
      headers: { origin }, body: { state, challenge } })).status).toBe(401);
    process.env.AUTH = "clerk";
  });

  test("wrong state or verifier does not consume a valid code, while expiry rejects it", async () => {
    const wrongState = await complete();
    expect((await exchange(wrongState.code, encoded(), wrongState.verifier)).status).toBe(400);
    expect((await exchange(wrongState.code, wrongState.state, encoded())).status).toBe(400);
    expect((await exchange(wrongState.code, wrongState.state, wrongState.verifier)).status).toBe(200);

    const expired = await complete();
    await db.update(verification).set({ expiresAt: new Date(0) })
      .where(eq(verification.identifier, `${prefix}${hash(expired.code)}`));
    expect((await exchange(expired.code, expired.state, expired.verifier)).status).toBe(400);
  });

  test("a provider mint failure consumes the code and returns no reusable secret", async () => {
    mint.mockReturnValue(({
      signInTokens: { createSignInToken: async () => { throw new Error("provider rejected"); } },
    }) as unknown as ReturnType<typeof identityClientModule.identityClient>);
    const created = await complete();
    const failed = await exchange(created.code, created.state, created.verifier);
    expect(failed.status).toBe(503);
    expect(failed.headers.get("cache-control")).toBe("no-store");
    expect(await failed.json()).toEqual({ error: "identity_unavailable" });
    expect((await exchange(created.code, created.state, created.verifier)).status).toBe(400);
  });
});
