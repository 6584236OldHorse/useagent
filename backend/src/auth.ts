import { electron } from "@better-auth/electron";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { createPersonalOrgForUser } from "./auth-hooks";
import { INVITATION_EXPIRES_IN_SECONDS, deliverInvitation, invitedSignupAllowed } from "./auth-invitations";
import { db } from "./db/client";
import * as schema from "./db/auth-schema";
import {
  betterAuthTrustedOrigins,
  env,
  googleAuthConfig,
  selfSignupEnabled,
} from "./env";

/**
 * Better Auth server with Google, existing-account password sign-in, and
 * organizations. Production creates no accounts on its own: a verified Google
 * identity links to an existing local user, or creates one only when a pending
 * organisation invitation names that email.
 */
export function createAuthServer() {
  const google = googleAuthConfig();
  const allowSignup = selfSignupEnabled();
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: true, disableSignUp: !allowSignup },
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
          before: async (user) => {
            // An invitation opens the door only to a verified identity: an unverified
            // email claim could be anyone naming the invited address. A stale verified
            // claim (a mailbox that changed hands) can still create an account, but
            // never joins the organisation: the invitation id travels only in the mail
            // and the by-email listing is closed in auth/routes.ts.
            const invited = user.emailVerified === true && (await invitedSignupAllowed(user.email));
            if (!selfSignupEnabled() && !invited) {
              throw APIError.from("FORBIDDEN", {
                code: "SIGNUP_DISABLED",
                message: "Account creation is disabled",
              });
            }
          },
          after: async (user) => {
            await createPersonalOrgForUser(user);
          },
        },
      },
    },
  });
}

export const auth = createAuthServer();
