import { parsePublishableKey } from "@clerk/shared/keys";

export interface IdentityMethods {
  google: boolean;
  github: boolean;
  emailPassword: boolean;
  emailCode: boolean;
  emailSignup: boolean;
  passwordSignup: boolean;
  signupAllowed: boolean;
}

export const NO_IDENTITY_METHODS: IdentityMethods = {
  google: false,
  github: false,
  emailPassword: false,
  emailCode: false,
  emailSignup: false,
  passwordSignup: false,
  signupAllowed: false,
};

type Attribute = { enabled?: unknown; used_for_first_factor?: unknown; first_factors?: unknown };
type Social = { enabled?: unknown; authenticatable?: unknown };
type Environment = {
  user_settings?: {
    attributes?: { email_address?: Attribute; password?: Attribute };
    social?: { oauth_google?: Social; oauth_github?: Social };
    sign_up?: { mode?: unknown };
  };
};

export function parseIdentityMethods(payload: unknown): IdentityMethods {
  const settings = (payload as Environment | null)?.user_settings;
  if (!settings?.attributes || !settings.social || !settings.sign_up) {
    throw new Error("Sign-in methods are unavailable. Please reload and try again.");
  }
  const email = settings.attributes.email_address;
  const emailSignIn = email?.used_for_first_factor === true;
  const emailSignup = email?.enabled === true;
  const socialEnabled = (provider: Social | undefined) =>
    provider?.enabled === true && provider.authenticatable === true;
  return {
    google: socialEnabled(settings.social.oauth_google),
    github: socialEnabled(settings.social.oauth_github),
    emailPassword: emailSignIn && settings.attributes.password?.enabled === true,
    emailCode:
      emailSignIn &&
      Array.isArray(email?.first_factors) &&
      email.first_factors.includes("email_code"),
    emailSignup,
    passwordSignup: emailSignup && settings.attributes.password?.enabled === true,
    signupAllowed: settings.sign_up.mode === "public",
  };
}

export async function loadIdentityMethods(
  publishableKey: string | undefined,
  fetcher: (url: URL, init: RequestInit) => Promise<Response> = fetch,
): Promise<IdentityMethods> {
  const { frontendApi } = parsePublishableKey(publishableKey, { fatal: true });
  // Public instance configuration, fetched server-side without browser credentials.
  const response = await fetcher(new URL(`https://${frontendApi}/v1/environment`), {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("Sign-in methods are unavailable.");
  return parseIdentityMethods(await response.json());
}
