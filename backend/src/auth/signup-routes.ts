import { getIp } from "better-auth/api";
import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { createAuthServer } from "../auth";
import { claimCondition, ensurePersonalOrgForUser } from "../auth-hooks";
import { readConfirmationToken } from "../auth-invitations";
import { db } from "../db/client";
import { user } from "../db/auth-schema";
import { env, openSignupConfig, signupRefusal } from "../env";
import type { AppEnv } from "../http";

/**
 * Open sign-up (SIGNUP_OPEN, env.ts) in front of the library's own routes: the
 * attempt limits, the policy answer, the release of stale unverified claims,
 * and the confirmation of a registration from its mailed link.
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

/** Delete the claim on this address, if that is all the account is, so the one
 *  who reads that mailbox can always finish a sign-up and a stale claim cannot
 *  hold the address. */
async function releaseUnverifiedClaim(email: string): Promise<void> {
  await db.delete(user).where(and(eq(user.email, email), claimCondition));
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

  /** Every attempt is counted, whatever the outcome. Only a JSON body passes
   *  this door (the library would also read a form), and the library reads the
   *  body exactly as checked here. The policy answers before the library looks
   *  anything up, so a refusal never tells whether the address has an account.
   *  A closed or development deployment gets the library's own answer, as before. */
  routes.post("/api/auth/sign-up/email", async (c) => {
    const request = c.req.raw;
    if (!openSignupConfig()) return auth.handler(request);
    if (!perClient(client(c))) return c.json({ message: TOO_MANY_ATTEMPTS }, 429);
    const body = await jsonBody(request);
    if (!body) return c.json({ message: "Send the sign-up as JSON" }, 400);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email) return c.json({ message: "Enter an email address" }, 400);
    if (!perAddress(email)) return c.json({ message: TOO_MANY_ATTEMPTS }, 429);
    const refusal = signupRefusal(email, body.inviteCode);
    if (refusal) return c.json({ message: refusal }, 403);
    await releaseUnverifiedClaim(email);
    return auth.handler(withJsonBody(request, body));
  });

  /** The mailed link. The token is checked before anything is looked up, and
   *  one statement decides: the registration it names is confirmed only while
   *  it still holds the address and is still unconfirmed. A sign-up that
   *  replaced it matches nothing, whatever the interleaving; a second click on
   *  a good link finds the registration confirmed and lands the same way. */
  routes.get("/api/auth/confirm-signup", async (c) => {
    const claim = readConfirmationToken(c.req.query("token") ?? "");
    if (claim === "invalid" || claim === "expired") return c.redirect(afterVerificationUrl(`error=link_${claim}`));
    const named = and(eq(user.id, claim.id), eq(user.email, claim.email));
    const [confirmed] = await db
      .update(user)
      .set({ emailVerified: true })
      .where(and(named, eq(user.emailVerified, false)))
      .returning({ id: user.id, name: user.name, email: user.email });
    const account =
      confirmed ??
      (await db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(and(named, eq(user.emailVerified, true))).limit(1))[0];
    if (!account) return c.redirect(afterVerificationUrl("error=signup_replaced"));
    await ensurePersonalOrgForUser(account);
    return c.redirect(afterVerificationUrl("verified=1"));
  });

  /** The library's own confirmation route is keyed by the address alone and
   *  nothing mails its links; it stays closed. */
  routes.get("/api/auth/verify-email", (c) => c.json({ message: "Not available" }, 404));

  /** Mail for a registration goes out only to whoever holds its password:
   *  sign-up creates it, sign-in proves it. Nobody can have a link sent to an
   *  address they merely typed. */
  routes.post("/api/auth/send-verification-email", (c) => c.json({ message: "Not available" }, 404));

  return routes;
}
