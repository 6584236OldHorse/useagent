import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { orgCreateLimitPerUser } from "../src/auth/organization-limit";
import { user } from "../src/db/auth-schema";
import { db } from "../src/db/client";
import { member } from "../src/db/schema";
import { CookieJar, createOrgSession, fetchApi, uid } from "./helpers";

// A person creates at most ORG_CREATE_LIMIT_PER_USER organisations, their
// personal one included; joining by invitation does not count, and the
// accounts in OPERATOR_ACCOUNTS have no limit.

const original = { limit: process.env.ORG_CREATE_LIMIT_PER_USER, operators: process.env.OPERATOR_ACCOUNTS };
afterEach(() => {
  for (const [name, value] of [["ORG_CREATE_LIMIT_PER_USER", original.limit], ["OPERATOR_ACCOUNTS", original.operators]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function createOrg(cookies: string) {
  return fetchApi("/api/auth/organization/create", {
    method: "POST", cookies, body: { name: "Another org", slug: uid("slug") },
  });
}

test("the limit is a positive whole number, else two", () => {
  expect(orgCreateLimitPerUser({})).toBe(2);
  expect(orgCreateLimitPerUser({ ORG_CREATE_LIMIT_PER_USER: "5" })).toBe(5);
  for (const junk of ["", "0", "-1", "1.5", "lots"]) expect(orgCreateLimitPerUser({ ORG_CREATE_LIMIT_PER_USER: junk })).toBe(2);
});

test("a person past the limit is refused another organisation; an operator is not", async () => {
  // Sign-up made the personal organisation and the helper created a second.
  const person = await createOrgSession("org-limit");
  const refused = await createOrg(person.cookies);
  expect(refused.status).toBe(403);
  expect(await refused.json()).toMatchObject({
    code: "YOU_HAVE_REACHED_THE_MAXIMUM_NUMBER_OF_ORGANIZATIONS",
    message: "You have reached the maximum number of organizations",
  });

  process.env.ORG_CREATE_LIMIT_PER_USER = "3";
  expect((await createOrg(person.cookies)).status).toBe(200);
  expect((await createOrg(person.cookies)).status).toBe(403);

  process.env.OPERATOR_ACCOUNTS = person.email.toUpperCase();
  expect((await createOrg(person.cookies)).status).toBe(200);
});

test("organisations joined by invitation do not count against the limit", async () => {
  const first = await createOrgSession("org-limit-first");
  const second = await createOrgSession("org-limit-second");
  const email = `${uid("org-limit-joiner")}@example.com`;
  const jar = new CookieJar();
  const signUp = await fetchApi("/api/auth/sign-up/email", {
    method: "POST", body: { name: "Joiner", email, password: "password-1234" },
  });
  expect(signUp.status).toBe(200);
  jar.absorb(signUp);
  const [joiner] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  // Their personal organisation, then two they were invited into.
  for (const orgId of [first.orgId, second.orgId]) {
    await db.insert(member).values({ id: uid("member"), organizationId: orgId, userId: joiner!.id, role: "member", createdAt: new Date() });
  }
  expect((await createOrg(jar.header())).status).toBe(200);
  expect((await createOrg(jar.header())).status).toBe(403);
});
