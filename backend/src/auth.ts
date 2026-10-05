import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { createPersonalOrgForUser } from "./auth-hooks";
import { db } from "./db/client";
import * as schema from "./db/auth-schema";
import {
  betterAuthTrustedOrigins,
  env,
  googleAuthConfig,
  selfSignupEnabled,
} from "./env";

/**
 * Better Auth server with Google, organizations, and development-only password
 * fixtures. Production user creation is rejected; verified Google identities
 * can only link to an existing local user.
 */
export function createAuthServer() {
  const google = googleAuthConfig();
  const allowPassword = selfSignupEnabled();
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(db, { provider: "pg", schema }),
    emailAndPassword: { enabled: allowPassword, disableSignUp: !allowPassword },
    socialProviders: google
      ? {
          google: {
            clientId: google.clientId,
            clientSecret: google.clientSecret,
            disableSignUp: !allowPassword,
          },
        }
      : {},
    account: { accountLinking: { requireLocalEmailVerified: false } },
    plugins: [organization()],
    trustedOrigins: betterAuthTrustedOrigins(),
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            if (!selfSignupEnabled()) {
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
