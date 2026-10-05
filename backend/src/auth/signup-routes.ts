import { getIp } from "better-auth/api";
import { and, eq, notExists } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { createAuthServer } from "../auth";
import { db } from "../db/client";
import { member, session, user } from "../db/auth-schema";
import { env, openSignupConfig, signupRefusal } from "../env";
import type { AppEnv } from "../http";

/**
 * Open sign-up (SIGNUP_OPEN, env.ts) in front of the library's own routes: the
 * attempt limits, the policy answer, the release of stale unverified claims,
 * and the binding of a mailed link to the registration it was mailed for.
 */

type Auth = ReturnType<typeof createAuthServer>;

/** Attempts per key in a fixed window; true while the key has attempts left. */
// ponytail: process-local, which matches the documented one-backend deployment; move to the database if replicas ever appear.
export function fixedWindow(max: number, windowMs: number): (key: string) => boolean {
  const seen = new Map<string, { count: number; since: number }>();
  return (key) => {
    const now = Date.now();
    for (const [other, entry] of seen) if (now - entry.since > windowMs) seen.delete(other);
    const entry = seen.get(key);
    if (!entry) {
      seen.set(key, { count: 1, since: now });
      return true;
    }
    if (entry.count >= max) return false;
    entry.count += 1;
    return true;
  };
}

export async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await request.clone().json()) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

/** The same request carrying this JSON body instead. */
export function withJsonBody(request: Request, body: Record<string, unknown>): Request {
  const next = new Request(request, { body: JSON.stringify(body) });
  next.headers.set("content-type", "application/json");
  next.headers.delete("content-length");
  return next;
}

const HOUR_MS = 3_600_000;
/** Sign-up attempts per address and per client per hour; asking for the mail
 *  again from the card is an attempt too. Guessing a shared invite code is
 *  bounded by the same counts. */
export const SIGNUP_ATTEMPTS_PER_ADDRESS = 10;
export const SIGNUP_ATTEMPTS_PER_CLIENT = 30;
const TOO_MANY_ATTEMPTS = "Too many sign-up attempts. Try again in an hour.";

/** Where a mailed link lands once the library has answered. The server pins it,
 *  so a sign-up body cannot send the verifying click anywhere else. */
function afterVerificationUrl(query: string): string {
  return new URL(`/login?${query}`, env.FRONTEND_ORIGIN).toString();
}

/** The address claim inside the library's verification token, read without the
 *  signature: the library checks that next; this only decides which account the
 *  link is about. */
function tokenEmail(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as { email?: unknown };
    return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Delete the account for this address if it never verified the address and
 *  was never used (no organisation, no session): a claim, not a person, so the
 *  one who reads that mailbox can always finish a sign-up and a stale claim
 *  cannot hold the address. Provisioned and development accounts have their
 *  organisation from creation and stay. */
async function releaseUnverifiedClaim(email: string): Promise<void> {
  await db.delete(user).where(
    and(
      eq(user.email, email),
      eq(user.emailVerified, false),
      notExists(db.select({ id: member.id }).from(member).where(eq(member.userId, user.id))),
      notExists(db.select({ id: session.id }).from(session).where(eq(session.userId, user.id))),
    ),
  );
}

export function createSignupRoutes(auth: Auth): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const perAddress = fixedWindow(SIGNUP_ATTEMPTS_PER_ADDRESS, HOUR_MS);
  const perClient = fixedWindow(SIGNUP_ATTEMPTS_PER_CLIENT, HOUR_MS);
  /** The address the edge saw (entries behind our own proxies are stripped),
   *  else the socket peer. Spoofable only by a client that reaches the backend
   *  without passing the edge, which is the host itself. */
  const client = (c: Context<AppEnv>): string =>
    getIp(c.req.raw, auth.options) ?? c.env?.requestIP?.(c.req.raw)?.address ?? "unknown";

  /** The attempt is counted first, whatever the outcome. The policy answers
   *  before the library looks anything up, so a refusal never tells whether
   *  the address has an account. A closed or development deployment gets the
   *  library's own answer, as before. */
  routes.post("/api/auth/sign-up/email", async (c) => {
    const request = c.req.raw;
    if (!openSignupConfig()) return auth.handler(request);
    const body = await jsonBody(request);
    if (!body || typeof body.email !== "string") return auth.handler(request); // the library reports the malformed body
    const email = body.email.trim().toLowerCase();
    if (!perAddress(email) || !perClient(client(c))) return c.json({ message: TOO_MANY_ATTEMPTS }, 429);
    const refusal = signupRefusal(email, body.inviteCode);
    if (refusal) return c.json({ message: refusal }, 403);
    await releaseUnverifiedClaim(email);
    return auth.handler(withJsonBody(request, { ...body, callbackURL: afterVerificationUrl("verified=1") }));
  });

  /** A mailed link verifies only the registration it was mailed for. If a later
   *  sign-up replaced that claim the link is dead and the card says to sign up
   *  again; the library alone would verify whichever account holds the address
   *  now, password included. */
  routes.get("/api/auth/verify-email", async (c) => {
    const email = tokenEmail(c.req.query("token") ?? "");
    const account = c.req.query("account") ?? "";
    const [current] = email
      ? await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1)
      : [];
    if (email && (!current || current.id !== account)) return c.redirect(afterVerificationUrl("error=signup_replaced"));
    return auth.handler(c.req.raw);
  });

  /** Mail for a registration goes out only to whoever holds its password:
   *  sign-up creates it, sign-in proves it. Nobody can have a link sent to an
   *  address they merely typed. */
  routes.post("/api/auth/send-verification-email", (c) => c.json({ message: "Not available" }, 404));

  return routes;
}
