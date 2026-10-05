import { electron } from "@better-auth/electron";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { createPersonalOrgForUser, unverifiedClaim } from "./auth-hooks";
import {
  INVITATION_EXPIRES_IN_SECONDS,
  confirmationLink,
  confirmationToken,
  deliverInvitation,
  deliverVerification,
  invitedSignupAllowed,
} from "./auth-invitations";
import { fixedWindow } from "./auth/signup-routes";
import { db } from "./db/client";
import * as schema from "./db/auth-schema";
import {
  betterAuthTrustedOrigins,
  env,
  googleAuthConfig,
  openSignupConfig,
  selfSignupEnabled,
  signupRefusal,
  signupSwitchOn,
} from "./env";

/** Hops whose forwarded-address entries are stripped when a client is resolved:
 *  the edge and any private proxy in front of the backend. The library's own
 *  limiter and the sign-up limiter then both see the address the edge saw. */
const TRUSTED_PROXIES = ["127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"];

/** Confirmation mails per address per hour, whatever asks for them: the
 *  sign-up, the card's resend, or a sign-in with the right password. */
export const VERIFICATION_MAILS_PER_ADDRESS = 5;

/**
 * Better Auth server with Google, existing-account password sign-in, and
 * organizations. A closed deployment creates no accounts on its own: a verified
 * Google identity links to an existing local user, or creates one only when a
 * pending organisation invitation names that email. SIGNUP_OPEN (env.ts) opens
 * email-and-password sign-up behind mail verification.
 */
export function createAuthServer() {
  const google = googleAuthConfig();
  const allowSignup = selfSignupEnabled();
  const open = openSignupConfig();
  const mailAllowed = fixedWindow(VERIFICATION_MAILS_PER_ADDRESS, 60 * 60 * 1000);
  if (signupSwitchOn() && !open) {
    console.warn(
      "[auth] SIGNUP_OPEN is set but no account mail transport is configured (CONNECTOR_EMAIL_HOST and CONNECTOR_EMAIL_FROM): sign-up stays closed, an address cannot be verified without mail.",
    );
  }
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowSignup,
      // An open sign-up is verified by mail before its first sign-in; a sign-in
      // with the right password for an unverified address sends the link again.
      requireEmailVerification: open !== null,
    },
    emailVerification: open
      ? {
          sendOnSignIn: true,
          // The library's own link (keyed by address alone) is not mailed; the
          // signed one names the registration (auth/signup-routes.ts confirms it).
          sendVerificationEmail: async ({ user }) => {
            if (!mailAllowed(user.email)) {
              console.warn(`[auth] confirmation mail for ${user.email} held: ${VERIFICATION_MAILS_PER_ADDRESS} already sent this hour`);
              return;
            }
            // The account exists whatever the mail does; the card can ask again.
            void deliverVerification(user.email, confirmationLink(confirmationToken(user))).catch((error: unknown) => {
              console.error(`[auth] verification mail for ${user.email} could not be sent:`, (error as Error).message);
            });
          },
        }
      : undefined,
    socialProviders: google
      ? {
          google: {
            clientId: google.clientId,
            clientSecret: google.clientSecret,
            // The user-create hook below decides, per email, whether a new
            // Google identity may become an account (invited, or dev mode).
            disableSignUp: false,
          },
        }
      : {},
    account: { accountLinking: { requireLocalEmailVerified: false } },
    advanced: { ipAddress: { trustedProxies: TRUSTED_PROXIES } },
    plugins: [
      organization({
        invitationExpiresIn: INVITATION_EXPIRES_IN_SECONDS,
        sendInvitationEmail: async (data) => {
          // The invitation exists whatever the mail does, and the request that
          // created it holds the organisation's turn: delivery runs on its own.
          void deliverInvitation(data).catch((error: unknown) => {
            console.error(`[auth] invitation ${data.id} could not be sent:`, (error as Error).message);
          });
        },
      }),
      electron(),
    ],
    trustedOrigins: betterAuthTrustedOrigins(),
    databaseHooks: {
      user: {
        create: {
          before: async (user, context) => {
            // An invitation opens the door only to a verified identity: an unverified
            // email claim could be anyone naming the invited address. A stale verified
            // claim (a mailbox that changed hands) can still create an account, but
            // never joins the organisation: the invitation id travels only in the mail
            // and the by-email listing is closed in auth/routes.ts.
            const invited = user.emailVerified === true && (await invitedSignupAllowed(user.email));
            if (invited) return;
            // Every other creation, whatever the provider, answers to the sign-up
            // policy: closed, or open and narrowed by domain and invite code. The
            // code travels in the sign-up body; a Google identity presents none.
            const refusal = signupRefusal(user.email, context?.body?.inviteCode);
            if (refusal) throw APIError.from("FORBIDDEN", { code: "SIGNUP_DISABLED", message: refusal });
          },
          after: async (user) => {
            // An open sign-up gets its organisation once the address is verified
            // (afterEmailVerification above); everyone else on creation.
            if (user.emailVerified || !open) await createPersonalOrgForUser(user);
          },
        },
      },
      session: {
        create: {
          before: async (session, context) => {
            // A claim (never confirmed, belongs nowhere) gets no session whatever
            // the switch says now: closing sign-up after such an account was
            // created must not let its password in. A claim can only sign in;
            // the session a sign-up makes for itself (development, where nothing
            // is confirmed and the organisation follows once the request's
            // transaction has committed) is not one.
            if (context?.path === "/sign-up/email") return;
            if (await unverifiedClaim(session.userId)) {
              throw APIError.from("FORBIDDEN", { code: "EMAIL_NOT_VERIFIED", message: "Confirm your email address first" });
            }
          },
        },
      },
      account: {
        create: {
          before: async (account) => {
            // A provider identity must not link to a claim (an account that never
            // confirmed its address and belongs nowhere): the link would confirm
            // the address and keep a stranger's password. The address's owner
            // signs up, which replaces the claim, and confirms; then the provider
            // links. Provisioned and Slack-created accounts have an organisation
            // and keep linking as before.
            if (account.providerId !== "credential" && (await unverifiedClaim(account.userId))) {
              throw APIError.from("FORBIDDEN", { code: "UNCONFIRMED_CLAIM", message: "Sign up with this address and confirm it first" });
            }
          },
        },
      },
    },
  });
}

export const auth = createAuthServer();
