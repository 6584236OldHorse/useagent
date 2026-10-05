export type FlowError = { longMessage?: string; message?: string } | null;

type Result = Promise<{ error: FlowError }>;
type Session = { currentTask?: { key: string } };
type Navigate = (params: {
  session: Session;
  decorateUrl: (url: string) => string;
  // biome-ignore lint/suspicious/noConfusingVoidType: matches Clerk's navigation callback contract
}) => void | Promise<unknown>;

export type NativeFactor =
  | "email_code"
  | "phone_code"
  | "password"
  | "passkey"
  | `oauth_${string}`
  | "totp"
  | "backup_code"
  | "reset_password_email_code"
  | "reset_password_phone_code";

export type IdentityFormStep =
  | "start"
  | "email-code"
  | "factor-select"
  | "factor-password"
  | "factor-code"
  | "new-password"
  | "protect-check"
  | "invitation";

export type AvailableNativeFactor = {
  strategy: NativeFactor;
  safeIdentifier?: string;
  emailAddressId?: string;
  phoneNumberId?: string;
  channel?: "sms" | "whatsapp";
};

export const SUPPORTED_SIGN_UP_FIELDS = new Set([
  "email_address",
  "first_name",
  "last_name",
  "password",
  "legal_accepted",
]);

type FactorMetadata = Omit<AvailableNativeFactor, "strategy"> & { strategy: string };

export function nativeFactors(factors: readonly FactorMetadata[]): AvailableNativeFactor[] {
  const supported = new Set<NativeFactor>([
    "email_code",
    "phone_code",
    "password",
    "passkey",
    "totp",
    "backup_code",
    "reset_password_email_code",
    "reset_password_phone_code",
  ]);
  return factors.filter(
    (factor): factor is AvailableNativeFactor =>
      supported.has(factor.strategy as NativeFactor) || factor.strategy.startsWith("oauth_"),
  );
}

export function nativeFactorKey(factor: AvailableNativeFactor): string {
  return [
    factor.strategy,
    factor.emailAddressId,
    factor.phoneNumberId,
    factor.channel,
    factor.safeIdentifier,
  ]
    .filter(Boolean)
    .join(":");
}

export function nativeFactorLabel(factor: AvailableNativeFactor): string {
  const destination = factor.safeIdentifier ? ` to ${factor.safeIdentifier}` : "";
  switch (factor.strategy) {
    case "email_code":
      return `Email a code${destination}`;
    case "phone_code":
      return factor.channel === "whatsapp"
        ? `Send a WhatsApp code${destination}`
        : factor.channel === "sms"
          ? `Send an SMS code${destination}`
          : `Text a code${destination}`;
    case "password":
      return "Use your password";
    case "passkey":
      return "Use a passkey";
    case "totp":
      return "Use an authenticator code";
    case "backup_code":
      return "Use a backup code";
    case "reset_password_email_code":
      return `Email a password reset code${destination}`;
    case "reset_password_phone_code":
      return `Text a password reset code${destination}`;
    default:
      return `Continue with ${factor.strategy.slice("oauth_".length).replaceAll("_", " ")}`;
  }
}

type NativeFactorFlow = {
  emailCode: {
    sendCode(params?: { emailAddressId?: string }): Result;
    verifyCode(params: { code: string }): Result;
  };
  phoneCode: {
    sendCode(params?: { phoneNumberId?: string; channel?: "sms" | "whatsapp" }): Result;
    verifyCode(params: { code: string }): Result;
  };
  mfa: {
    sendEmailCode(): Result;
    sendPhoneCode(): Result;
    verifyEmailCode(params: { code: string }): Result;
    verifyPhoneCode(params: { code: string }): Result;
    verifyTOTP(params: { code: string }): Result;
    verifyBackupCode(params: { code: string }): Result;
  };
  resetPasswordEmailCode: { sendCode(): Result; verifyCode(params: { code: string }): Result };
  resetPasswordPhoneCode: { sendCode(): Result; verifyCode(params: { code: string }): Result };
};

export type SignInFlow = {
  status: string;
  isTransferable: boolean;
  supportedFirstFactors: { strategy: string }[];
  existingSession?: { sessionId: string };
  create(params: { transfer: true }): Result;
  finalize(params: { navigate: Navigate }): Result;
};

export type SignUpFlow = {
  status: string;
  isTransferable: boolean;
  existingSession?: { sessionId: string };
  create(params: { transfer: true }): Result;
  finalize(params: { navigate: Navigate }): Result;
};

export type ResumedIdentityStep =
  | { step: "factor-select"; factorStage: "first" | "second" }
  | { step: "new-password" | "protect-check" | "email-code" | "invitation" };

export function resumedIdentityStep(
  mode: "sign-in" | "sign-up",
  signIn: { id?: string; status: string },
  signUp: { id?: string; status: string; unverifiedFields: string[] },
): ResumedIdentityStep | null {
  if (mode === "sign-in" && signIn.id) {
    if (signIn.status === "needs_first_factor") {
      return { step: "factor-select", factorStage: "first" };
    }
    if (signIn.status === "needs_second_factor" || signIn.status === "needs_client_trust") {
      return { step: "factor-select", factorStage: "second" };
    }
    if (signIn.status === "needs_new_password") return { step: "new-password" };
    if (signIn.status === "needs_protect_check") return { step: "protect-check" };
  }
  if (mode === "sign-up" && signUp.id && signUp.status === "missing_requirements") {
    return {
      step: signUp.unverifiedFields.includes("email_address") ? "email-code" : "invitation",
    };
  }
  return null;
}

export async function sendSignInEmailCode(
  signIn: { emailCode: { sendCode(params: { emailAddress: string }): Result } },
  emailAddress: string,
) {
  const { error } = await signIn.emailCode.sendCode({ emailAddress });
  if (error) throw new Error(errorMessage(error));
}

export async function sendSignUpEmailCode(signUp: { verifications: { sendEmailCode(): Result } }) {
  const { error } = await signUp.verifications.sendEmailCode();
  if (error) throw new Error(errorMessage(error));
}

export async function submitExistingPassword(
  signIn: { password(params: { password: string }): Result },
  password: string,
) {
  const { error } = await signIn.password({ password });
  if (error) throw new Error(errorMessage(error));
}

export async function startNativeFactor(
  signIn: NativeFactorFlow,
  stage: "first" | "second",
  factor: AvailableNativeFactor,
) {
  let result: { error: FlowError };
  if (stage === "second") {
    if (factor.strategy === "email_code") result = await signIn.mfa.sendEmailCode();
    else if (factor.strategy === "phone_code") result = await signIn.mfa.sendPhoneCode();
    else if (factor.strategy === "totp" || factor.strategy === "backup_code")
      result = { error: null };
    else throw new Error("That verification method is not available at this step.");
  } else if (factor.strategy === "email_code" && factor.emailAddressId) {
    result = await signIn.emailCode.sendCode({ emailAddressId: factor.emailAddressId });
  } else if (factor.strategy === "phone_code" && factor.phoneNumberId) {
    result = await signIn.phoneCode.sendCode({
      phoneNumberId: factor.phoneNumberId,
      channel: factor.channel,
    });
  } else if (factor.strategy === "reset_password_email_code") {
    result = await signIn.resetPasswordEmailCode.sendCode();
  } else if (factor.strategy === "reset_password_phone_code") {
    result = await signIn.resetPasswordPhoneCode.sendCode();
  } else throw new Error("That verification method is not available at this step.");
  if (result.error) throw new Error(errorMessage(result.error));
}

export async function verifyNativeFactor(
  signIn: NativeFactorFlow,
  stage: "first" | "second",
  factor: NativeFactor,
  code: string,
) {
  let result: { error: FlowError };
  if (stage === "second") {
    if (factor === "email_code") result = await signIn.mfa.verifyEmailCode({ code });
    else if (factor === "phone_code") result = await signIn.mfa.verifyPhoneCode({ code });
    else if (factor === "totp") result = await signIn.mfa.verifyTOTP({ code });
    else if (factor === "backup_code") result = await signIn.mfa.verifyBackupCode({ code });
    else throw new Error("That verification method is not available at this step.");
  } else if (factor === "email_code") result = await signIn.emailCode.verifyCode({ code });
  else if (factor === "phone_code") result = await signIn.phoneCode.verifyCode({ code });
  else if (factor === "reset_password_email_code") {
    result = await signIn.resetPasswordEmailCode.verifyCode({ code });
  } else if (factor === "reset_password_phone_code") {
    result = await signIn.resetPasswordPhoneCode.verifyCode({ code });
  } else throw new Error("That verification method is not available at this step.");
  if (result.error) throw new Error(errorMessage(result.error));
}

export function internalRedirect(value: string | null | undefined): string {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/";
  const url = new URL(value, "https://useagent.invalid");
  return url.origin === "https://useagent.invalid"
    ? `${url.pathname}${url.search}${url.hash}`
    : "/";
}

export function errorMessage(
  error: FlowError,
  fallback = "Something went wrong. Please try again.",
): string {
  return error?.longMessage || error?.message || fallback;
}

async function finish(
  flow: { finalize(params: { navigate: Navigate }): Result },
  navigate: Navigate,
) {
  const { error } = await flow.finalize({ navigate });
  if (error) throw new Error(errorMessage(error));
}

export async function completeRedirectFlow({
  signIn,
  signUp,
  setActive,
  navigate,
}: {
  signIn: SignInFlow;
  signUp: SignUpFlow;
  setActive: (params: { session: string; navigate: Navigate }) => Promise<unknown>;
  navigate: Navigate;
}): Promise<"complete" | "sign-in" | "sign-up"> {
  if (signIn.status === "complete") {
    await finish(signIn, navigate);
    return "complete";
  }

  if (signUp.isTransferable) {
    const { error } = await signIn.create({ transfer: true });
    if (error) throw new Error(errorMessage(error));
    if (signIn.status === "complete") {
      await finish(signIn, navigate);
      return "complete";
    }
    return "sign-in";
  }

  if (
    signIn.status === "needs_first_factor" &&
    !signIn.supportedFirstFactors.every((factor) => factor.strategy === "enterprise_sso")
  ) {
    return "sign-in";
  }

  if (signIn.isTransferable) {
    const { error } = await signUp.create({ transfer: true });
    if (error) throw new Error(errorMessage(error));
    if (signUp.status === "complete") {
      await finish(signUp, navigate);
      return "complete";
    }
    return "sign-up";
  }

  if (signUp.status === "complete") {
    await finish(signUp, navigate);
    return "complete";
  }

  const sessionId = signIn.existingSession?.sessionId || signUp.existingSession?.sessionId;
  if (sessionId) {
    await setActive({ session: sessionId, navigate });
    return "complete";
  }

  if (
    signIn.status === "needs_second_factor" ||
    signIn.status === "needs_client_trust" ||
    signIn.status === "needs_new_password" ||
    signIn.status === "needs_protect_check"
  ) {
    return "sign-in";
  }

  return signUp.status === "missing_requirements" ? "sign-up" : "sign-in";
}
