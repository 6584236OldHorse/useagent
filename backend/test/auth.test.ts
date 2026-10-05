import { describe, expect, test } from "bun:test";
import { CookieJar, createOrgSession, fetchApi, json, uid } from "./helpers";

const SESSION_COOKIE = "better-auth.session_token";

describe("auth", () => {
  test("sign-up → session cookie → get-session", async () => {
    const email = `${uid("auth")}@example.com`;
    const password = "correct-horse-battery";
    const jar = new CookieJar();

    const signUp = await fetchApi("/api/auth/sign-up/email", {
      method: "POST",
      body: { name: "Test User", email, password },
    });
    expect(signUp.status).toBe(200);
    jar.absorb(signUp);
    expect(jar.has(SESSION_COOKIE)).toBe(true);

    // The session cookie authenticates get-session.
    const session = await json<any>("/api/auth/get-session", {
      cookies: jar.header(),
    });
    expect(session.status).toBe(200);
    expect(session.body?.user?.email).toBe(email);
  });

  test("wrong password → 401", async () => {
    const email = `${uid("auth")}@example.com`;
    const password = "the-real-password";

    const signUp = await fetchApi("/api/auth/sign-up/email", {
      method: "POST",
      body: { name: "Pw User", email, password },
    });
    expect(signUp.status).toBe(200);

    const bad = await fetchApi("/api/auth/sign-in/email", {
      method: "POST",
      body: { email, password: "not-the-password" },
    });
    expect(bad.status).toBe(401);
  });

  test("only the signed-in matching user can accept an organization invitation", async () => {
    const owner = await createOrgSession("invite-owner");
    const inviteeEmail = `${uid("invitee")}@example.com`;
    const invited = await json<{ id: string }>("/api/auth/organization/invite-member", {
      method: "POST",
      cookies: owner.cookies,
      body: { email: inviteeEmail, role: "member", organizationId: owner.orgId },
    });
    expect(invited.status).toBe(200);

    const accept = (cookies?: string) =>
      fetchApi("/api/auth/organization/accept-invitation", {
        method: "POST",
        cookies,
        body: { invitationId: invited.body.id },
      });
    expect((await accept()).status).toBe(401);
    expect((await accept(owner.cookies)).status).toBe(403);

    const invitee = new CookieJar();
    const signup = await fetchApi("/api/auth/sign-up/email", {
      method: "POST",
      body: { name: "Invited User", email: inviteeEmail, password: "password-1234" },
    });
    expect(signup.status).toBe(200);
    invitee.absorb(signup);
    expect((await accept(invitee.header())).status).toBe(200);
  });
});
