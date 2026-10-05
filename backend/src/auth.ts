import { electron } from "@better-auth/electron";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { createPersonalOrgForUser, ensurePersonalOrgForUser } from "./auth-hooks";
import {
  INVITATION_EXPIRES_IN_SECONDS,
  deliverInvitation,
  deliverVerification,
  invitedSignupAllowed,
  verificationLink,
} from "./auth-invitations";
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
          sendVerificationEmail: async ({ user, url }) => {
            // The account exists whatever the mail does; the card can ask again.
            void deliverVerification(user.email, verificationLink(url, user.id)).catch((error: unknown) => {
              console.error(`[auth] verification mail for ${user.email} could not be sent:`, (error as Error).message);
            });
          },
          afterEmailVerification: async (user) => {
            await ensurePersonalOrgForUser(user);
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
    // While sign-up is open, a local account that never verified its address is
    // nobody's yet: a Google identity with that address must not link to it and
    // inherit its password. The address's owner signs up and verifies, then
    // Google links. A closed deployment keeps linking to provisioned accounts.
    account: { accountLinking: { requireLocalEmailVerified: open !== null } },
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
    },
  });
}

export const auth = createAuthServer();
