/**
 * What the login card says about a confirmation link that landed here. The
 * backend sends every confirming click to `/login?verified=1`, or to
 * `/login?error=<code>` when the link was not good.
 */
export interface VerificationNotice {
  readonly tone: "ok" | "problem";
  readonly text: string;
}

export function verificationNotice(params: {
  verified?: string | string[];
  declined?: string | string[];
  error?: string | string[];
}): VerificationNotice | null {
  const error = typeof params.error === "string" ? params.error : null;
  if (error === "signup_replaced") {
    return {
      tone: "problem",
      text: "That confirmation link is from an earlier sign-up that a newer one replaced. Sign up again to get a fresh link.",
    };
  }
  if (error === "link_expired") {
    return {
      tone: "problem",
      text: "That confirmation link has expired. Sign in with your password and we will send a new one.",
    };
  }
  if (error) {
    return {
      tone: "problem",
      text: "That confirmation link is not valid. Sign in with your password and we will send a new one.",
    };
  }
  if (params.verified === "1") return { tone: "ok", text: "Your email address is confirmed. Sign in to continue." };
  if (params.declined === "1") return { tone: "ok", text: "That sign-up was cancelled. Nothing was created for your address." };
  if (params.declined === "nothing") {
    return {
      tone: "problem",
      text: "Nothing was cancelled: that sign-up was already confirmed, or a newer sign-up replaced it. If the account is not yours, sign in with your own password to take it over.",
    };
  }
  return null;
}
