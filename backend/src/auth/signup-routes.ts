import { getIp } from "better-auth/api";
import { and, eq, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { createAuthServer } from "../auth";
import { claimCondition, ensurePersonalOrgForUser } from "../auth-hooks";
import {
  confirmationLinks,
  confirmationToken,
  deliverVerification,
  invitedSignupAllowed,
  readConfirmationToken,
} from "../auth-invitations";
import { db } from "../db/client";
import { user } from "../db/auth-schema";
import { env, openSignupConfig, signupRefusal } from "../env";
import type { AppEnv } from "../http";

/**
 * Open sign-up (SIGNUP_OPEN, env.ts) in front of the library's own routes: the
 * attempt limits, the policy answer, the replacement of stale unverified
 * claims, the confirmation of a registration from its mailed link, and the
 * honest answer about mail on a sign-in that is not confirmed yet.
 */

type Auth = ReturnType<typeof createAuthServer>;

/** Attempts per key in a fixed window: 0 when this attempt is admitted, else
 *  the milliseconds until the window has passed. */
// ponytail: process-local and gone on restart, which matches the documented one-backend deployment; move to the database if replicas or restart-proof counts are ever needed.
export function fixedWindow(max: number, windowMs: number): (key: string) => number {
  const seen = new Map<string, { count: number; since: number }>();
  return (key) => {
    const now = Date.now();
    for (const [other, entry] of seen) if (now - entry.since > windowMs) seen.delete(other);
    const entry = seen.get(key);
    if (!entry) {
      seen.set(key, { count: 1, since: now });
      return 0;
    }
    if (entry.count >= max) return entry.since + windowMs - now;
    entry.count += 1;
    return 0;
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
/** Confirmation mails a sign-in with the right password may cause per address
 *  per hour: the only way to make mail besides a sign-up attempt. */
export const SIGN_IN_CONFIRMATION_MAILS_PER_ADDRESS = 5;
const TOO_MANY_ATTEMPTS = "Too many sign-up attempts. Try again later.";

/** What happened to the confirmation mail a sign-in asked for. */
export type SignInMail =
  | { readonly sent: true }
  | { readonly sent: false; readonly reason: "held"; readonly retryAfterSeconds: number }
  | { readonly sent: false; readonly reason: "closed" };

/** Where a mailed link lands once it has been judged. The server decides it,
 *  so a sign-up body cannot send the click anywhere else. */
function afterVerificationUrl(query: string): string {
  return new URL(`/login?${query}`, env.FRONTEND_ORIGIN).toString();
}

function tooMany(c: Context<AppEnv>, waitMs: number): Response {
  const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));
  c.header("retry-after", String(retryAfterSeconds));
  return c.json({ message: TOO_MANY_ATTEMPTS, retryAfterSeconds }, 429);
}

/** Set the claim on this address aside, if that is all the account is: its
 *  address becomes free for the registration being made, while the row stays
 *  until that registration is accepted. It is parked under its own id, so two
 *  parkings can never collide. */
async function parkClaim(email: string): Promise<string | null> {
  const [parked] = await db
    .update(user)
    .set({ email: sql`${user.id} || '@claim.invalid'` })
    .where(and(eq(user.email, email), claimCondition))
    .returning({ id: user.id });
  return parked?.id ?? null;
}

/** The registration was refused: the parked claim gets its address back and its
 *  link keeps working. If a creation took the address in between, the newer
 *  registration stands and the parked claim goes. */
async function restoreParked(id: string, email: string): Promise<void> {
  try {
    await db.update(user).set({ email }).where(eq(user.id, id));
  } catch {
    await db.delete(user).where(eq(user.id, id));
  }
}

export function createSignupRoutes(auth: Auth): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();
  const perAddress = fixedWindow(SIGNUP_ATTEMPTS_PER_ADDRESS, HOUR_MS);
  const perClient = fixedWindow(SIGNUP_ATTEMPTS_PER_CLIENT, HOUR_MS);
  const signInMail = fixedWindow(SIGN_IN_CONFIRMATION_MAILS_PER_ADDRESS, HOUR_MS);
  /** The address the edge saw (entries behind our own proxies are stripped),
   *  else the socket peer. Spoofable only by a client that reaches the backend
   *  without passing the edge, which is the host itself. */
  const client = (c: Context<AppEnv>): string =>
    getIp(c.req.raw, auth.options) ?? c.env?.requestIP?.(c.req.raw)?.address ?? "unknown";

  /** Every attempt is counted, whatever the outcome. Only a JSON body passes
   *  this door (the library would also read a form), and the library reads the
   *  body exactly as checked here. The policy answers before the library looks
   *  anything up, so a refusal never tells whether the address has an account.
   *  A claim on the address is set aside, not deleted, and the library is
   *  called once: accepted, the fresh registration exists with its mail on the
   *  way and the claim goes; refused for any reason, its own limits included,
   *  the claim gets its address back and its link keeps working. A person's
   *  account is never set aside; the library answers for it as it always has.
   *  A closed or development deployment gets the library's own answer, as before. */
  routes.post("/api/auth/sign-up/email", async (c) => {
    const request = c.req.raw;
    if (!openSignupConfig()) return auth.handler(request);
    const clientWait = perClient(client(c));
    if (clientWait) return tooMany(c, clientWait);
    const body = await jsonBody(request);
    if (!body) return c.json({ message: "Send the sign-up as JSON" }, 400);
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email) return c.json({ message: "Enter an email address" }, 400);
    const addressWait = perAddress(email);
    if (addressWait) return tooMany(c, addressWait);
    const refusal = signupRefusal(email, body.inviteCode, process.env, await invitedSignupAllowed(email));
    if (refusal) return c.json({ message: refusal }, 403);
    const parked = await parkClaim(email);
    let response = await auth.handler(withJsonBody(request, body));
    if (parked) await (response.ok ? db.delete(user).where(eq(user.id, parked)) : restoreParked(parked, email));
    // The library's own limiter names its wait in a header of its own; say it the standard way too.
    if (response.status === 429 && !response.headers.has("retry-after") && response.headers.has("x-retry-after")) {
      response = new Response(response.body, response);
      response.headers.set("retry-after", response.headers.get("x-retry-after")!);
    }
    return response;
  });

  /** The library (while open) or the session hook (closed) refuses a sign-in
   *  for an unconfirmed address only once the password was right. The mail is
   *  sent from here, so the answer can say what happened to it: on its way,
   *  held because this address already had its share this hour, or not
   *  possible because sign-up is closed. */
  routes.post("/api/auth/sign-in/email", async (c) => {
    const request = c.req.raw;
    const body = await jsonBody(request);
    const response = await auth.handler(request);
    if (response.status !== 403) return response;
    const answer = (await response.clone().json().catch(() => null)) as { code?: unknown } | null;
    if (answer?.code !== "EMAIL_NOT_VERIFIED") return response;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    let mail: SignInMail = { sent: false, reason: "closed" };
    if (openSignupConfig()) {
      const wait = signInMail(email);
      if (wait) mail = { sent: false, reason: "held", retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) };
      else {
        const [pending] = await db
          .select({ id: user.id, email: user.email })
          .from(user)
          .where(and(eq(user.email, email), eq(user.emailVerified, false)))
          .limit(1);
        if (pending) {
          void deliverVerification(pending.email, confirmationLinks(confirmationToken(pending))).catch((error: unknown) => {
            console.error(`[auth] verification mail for ${pending.email} could not be sent:`, (error as Error).message);
          });
        }
        mail = { sent: true };
      }
    }
    return c.json({ ...answer, mail }, 403);
  });

  /** The mailed link. The token is checked before anything is looked up. The
   *  confirmation and the personal organisation land together, with the row
   *  locked until both are in, so whoever looks at the account next (Slack
   *  admission, a second click) sees a confirmed person with a workspace, in
   *  whichever order things arrive. The registration the token names is
   *  confirmed only while it still holds the address; a sign-up that replaced
   *  it matches nothing, whatever the interleaving. */
  routes.get("/api/auth/confirm-signup", async (c) => {
    const claim = readConfirmationToken(c.req.query("token") ?? "");
    if (claim === "invalid" || claim === "expired") return c.redirect(afterVerificationUrl(`error=link_${claim}`));
    const named = and(eq(user.id, claim.id), eq(user.email, claim.email));
    const account = await db.transaction(async (tx) => {
      const [confirmed] = await tx
        .update(user)
        .set({ emailVerified: true })
        .where(and(named, eq(user.emailVerified, false)))
        .returning({ id: user.id, name: user.name, email: user.email });
      const found =
        confirmed ??
        (
          await tx
            .select({ id: user.id, name: user.name, email: user.email })
            .from(user)
            .where(and(named, eq(user.emailVerified, true)))
            .for("update")
        )[0];
      if (found) await ensurePersonalOrgForUser(found, tx);
      return found ?? null;
    });
    if (!account) return c.redirect(afterVerificationUrl("error=signup_replaced"));
    return c.redirect(afterVerificationUrl("verified=1"));
  });

  /** The mail's "this was not me": the registration the token names goes away
   *  while it is still a claim. A confirmed account, or a claim a later sign-up
   *  replaced, is untouched, and the card says that nothing was cancelled. */
  routes.get("/api/auth/decline-signup", async (c) => {
    const claim = readConfirmationToken(c.req.query("token") ?? "");
    if (claim === "invalid" || claim === "expired") return c.redirect(afterVerificationUrl(`error=link_${claim}`));
    const gone = await db
      .delete(user)
      .where(and(eq(user.id, claim.id), eq(user.email, claim.email), claimCondition))
      .returning({ id: user.id });
    return c.redirect(afterVerificationUrl(gone.length ? "declined=1" : "declined=nothing"));
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
