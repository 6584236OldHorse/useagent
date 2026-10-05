import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../db/client";
import { organization, user, verification } from "../db/auth-schema";
import { betterAuthTrustedOrigins } from "../env";
import type { AppEnv } from "../http";
import { identityClient } from "./clerk/client";
import { authProvider } from "./session";

const PREFIX = "desktop-handoff:";
const MAX_EXPIRED_CLEANUP = 100;

interface StoredHandoff {
  state: string;
  challenge: string;
  clerkUserId: string;
  clerkOrgId: string | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function isBase64Url32(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}

function isJson(c: Context<AppEnv>): boolean {
  return c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function allowedOrigin(c: Context<AppEnv>, required: boolean): boolean {
  const origin = c.req.header("origin");
  return origin ? betterAuthTrustedOrigins().includes(origin) : !required;
}

function hasSessionCookie(c: Context<AppEnv>): boolean {
  return c.req.header("authorization") === undefined &&
    c.req.header("cookie")?.split(";").some((part) => /^\s*__session=.+/.test(part)) === true;
}

async function body(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  if (!isJson(c)) return null;
  try {
    const value: unknown = await c.req.json();
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function cleanupExpired(): Promise<void> {
  await db.delete(verification).where(sql`${verification.id} in (
    select ${verification.id} from ${verification}
    where ${verification.identifier} like ${`${PREFIX}%`}
      and ${verification.expiresAt} <= now()
    limit ${MAX_EXPIRED_CLEANUP}
  )`);
}

export async function completeDesktopHandoff(c: Context<AppEnv>): Promise<Response> {
  c.header("Cache-Control", "no-store");
  if (authProvider() !== "clerk" || !allowedOrigin(c, true)) {
    return c.json({ error: "forbidden" }, 403);
  }
  if (!hasSessionCookie(c)) return c.json({ error: "unauthorized" }, 401);
  const input = await body(c);
  if (!input || !isBase64Url32(input.state) || !isBase64Url32(input.challenge)) {
    return c.json({ error: "invalid_request" }, 400);
  }
  const userId = c.get("userId");
  const orgId = c.get("orgId");
  if (!userId || !orgId) return c.json({ error: "unauthorized" }, 401);

  const [[localUser], [localOrg]] = await Promise.all([
    db.select({ clerkUserId: user.clerkUserId }).from(user).where(eq(user.id, userId)).limit(1),
    db.select({ clerkOrgId: organization.clerkOrgId }).from(organization).where(eq(organization.id, orgId)).limit(1),
  ]);
  if (!localUser?.clerkUserId || !localOrg) return c.json({ error: "forbidden" }, 403);

  await cleanupExpired();
  const code = randomBytes(32).toString("base64url");
  const stored: StoredHandoff = {
    state: input.state,
    challenge: input.challenge,
    clerkUserId: localUser.clerkUserId,
    clerkOrgId: localOrg.clerkOrgId,
  };
  await db.insert(verification).values({
    id: crypto.randomUUID(),
    identifier: `${PREFIX}${sha256(code)}`,
    value: JSON.stringify(stored),
    expiresAt: sql`now() + interval '60 seconds'`,
  });
  return c.json({ url: `useagent://auth/callback?code=${code}&state=${input.state}` });
}

export async function exchangeDesktopHandoff(c: Context<AppEnv>): Promise<Response> {
  c.header("Cache-Control", "no-store");
  if (authProvider() !== "clerk") return c.json({ error: "forbidden" }, 403);
  if (!allowedOrigin(c, false)) return c.json({ error: "forbidden" }, 403);
  const input = await body(c);
  if (
    !input ||
    !isBase64Url32(input.code) ||
    !isBase64Url32(input.state) ||
    !isBase64Url32(input.verifier)
  ) {
    return c.json({ error: "invalid_request" }, 400);
  }

  await cleanupExpired();
  const challenge = sha256(input.verifier);
  const [consumed] = await db
    .delete(verification)
    .where(and(
      eq(verification.identifier, `${PREFIX}${sha256(input.code)}`),
      gt(verification.expiresAt, sql`now()`),
      sql`${verification.value}::jsonb ->> 'state' = ${input.state}`,
      sql`${verification.value}::jsonb ->> 'challenge' = ${challenge}`,
    ))
    .returning({ value: verification.value });
  if (!consumed) return c.json({ error: "invalid_request" }, 400);

  let stored: StoredHandoff;
  try {
    stored = JSON.parse(consumed.value) as StoredHandoff;
    if (!stored.clerkUserId) throw new Error();
  } catch {
    return c.json({ error: "identity_unavailable" }, 503);
  }
  const ticket = await identityClient().signInTokens.createSignInToken({
    userId: stored.clerkUserId,
    ...(stored.clerkOrgId ? { orgId: stored.clerkOrgId } : {}),
    expiresInSeconds: 60,
  });
  return c.json({ ticket: ticket.token });
}
