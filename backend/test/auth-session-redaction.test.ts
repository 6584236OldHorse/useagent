import { expect, test } from "bun:test";
import { createOrgSession, json } from "./helpers";

const tokenKeys = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(tokenKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => (/token/i.test(key) ? [key] : tokenKeys(item)));
};

test("session reads keep identity and workspace but never carry a session token", async () => {
  const browser = await createOrgSession("session-redaction");
  const current = await json("/api/auth/get-session", { cookies: browser.cookies });
  expect(current.status).toBe(200);
  expect(current.body.user.email).toBe(browser.email);
  expect(typeof current.body.session.id).toBe("string");
  expect(typeof current.body.session.expiresAt).toBe("string");
  expect(current.body.session.activeOrganizationId).toBe(browser.orgId);
  expect(tokenKeys(current.body)).toEqual([]);

  const sessions = await json("/api/auth/list-sessions", { cookies: browser.cookies });
  expect(sessions.status).toBe(200);
  expect(sessions.body.map((session: { id: string }) => session.id)).toContain(current.body.session.id);
  expect(tokenKeys(sessions.body)).toEqual([]);

  expect((await json("/api/auth/get-session")).body).toBeNull();
});
