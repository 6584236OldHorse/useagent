import { describe, expect, test } from "bun:test";

import {
  completeRedirectFlow,
  errorMessage,
  internalRedirect,
  nativeFactorKey,
  nativeFactorLabel,
  nativeFactors,
  resumedIdentityStep,
  sendSignInEmailCode,
  sendSignUpEmailCode,
  startNativeFactor,
  submitExistingPassword,
  verifyNativeFactor,
} from "./identity-flow";

const ok = async () => ({ error: null });
const navigate = () => {};

describe("native identity transitions", () => {
  test("finalizes completed sign-in and preserves only internal redirects", async () => {
    let finalized = false;
    const signIn = {
      status: "complete",
      isTransferable: false,
      supportedFirstFactors: [],
      create: ok,
      finalize: async () => {
        finalized = true;
        return { error: null };
      },
    };
    const signUp = {
      status: "missing_requirements",
      isTransferable: false,
      create: ok,
      finalize: ok,
    };

    expect(
      await completeRedirectFlow({ signIn, signUp, setActive: async () => {}, navigate }),
    ).toBe("complete");
    expect(finalized).toBe(true);
    expect(internalRedirect("/agent/new?from=desktop#ready")).toBe("/agent/new?from=desktop#ready");
    expect(internalRedirect("https://evil.example/phish")).toBe("/");
    expect(internalRedirect("//evil.example/phish")).toBe("/");
  });

  test("transfers SSO sign-in to signup and fails closed on provider errors", async () => {
    const signIn = {
      status: "needs_identifier",
      isTransferable: true,
      supportedFirstFactors: [],
      create: ok,
      finalize: ok,
    };
    const signUp = {
      status: "missing_requirements",
      isTransferable: false,
      create: ok,
      finalize: ok,
    };
    expect(
      await completeRedirectFlow({ signIn, signUp, setActive: async () => {}, navigate }),
    ).toBe("sign-up");

    signUp.create = async () => ({ error: { longMessage: "Invitation is invalid." } });
    await expect(
      completeRedirectFlow({ signIn, signUp, setActive: async () => {}, navigate }),
    ).rejects.toThrow("Invitation is invalid.");
  });

  test("keeps non-enterprise first-factor verification in sign-in before transfer", async () => {
    let transferred = false;
    const signIn = {
      status: "needs_first_factor",
      isTransferable: true,
      supportedFirstFactors: [{ strategy: "email_code" }],
      create: ok,
      finalize: ok,
    };
    const signUp = {
      status: "missing_requirements",
      isTransferable: false,
      create: async () => {
        transferred = true;
        return { error: null };
      },
      finalize: ok,
    };

    expect(
      await completeRedirectFlow({ signIn, signUp, setActive: async () => {}, navigate }),
    ).toBe("sign-in");
    expect(transferred).toBe(false);
  });

  test("keeps pending MFA ahead of an empty signup fallback", async () => {
    const signIn = {
      status: "needs_second_factor",
      isTransferable: false,
      supportedFirstFactors: [],
      create: ok,
      finalize: ok,
    };
    const signUp = {
      status: "missing_requirements",
      isTransferable: false,
      create: ok,
      finalize: ok,
    };

    expect(
      await completeRedirectFlow({ signIn, signUp, setActive: async () => {}, navigate }),
    ).toBe("sign-in");
  });

  test("continues an OAuth collision with the existing account password and finalizes", async () => {
    let status = "needs_first_factor";
    let finalized = false;
    const signIn = {
      get status() {
        return status;
      },
      isTransferable: true,
      supportedFirstFactors: [{ strategy: "password" }],
      create: ok,
      password: async ({ password }: { password: string }) => {
        expect(password).toBe("existing-secret");
        status = "complete";
        return { error: null };
      },
      finalize: async () => {
        finalized = true;
        return { error: null };
      },
    };
    const signUp = {
      status: "missing_requirements",
      isTransferable: false,
      create: ok,
      finalize: ok,
    };

    expect(
      await completeRedirectFlow({ signIn, signUp, setActive: async () => {}, navigate }),
    ).toBe("sign-in");
    await submitExistingPassword(signIn, "existing-secret");
    expect(
      await completeRedirectFlow({ signIn, signUp, setActive: async () => {}, navigate }),
    ).toBe("complete");
    expect(finalized).toBe(true);
  });

  test("starts passwordless email verification and surfaces provider errors", async () => {
    let sentTo = "";
    const signIn = {
      emailCode: {
        sendCode: async ({ emailAddress }: { emailAddress: string }) => {
          sentTo = emailAddress;
          return { error: null };
        },
      },
    };

    await sendSignInEmailCode(signIn, "migrated@example.com");
    expect(sentTo).toBe("migrated@example.com");

    signIn.emailCode.sendCode = async () => ({
      error: { longMessage: "Email codes are unavailable." },
    });
    await expect(sendSignInEmailCode(signIn, "migrated@example.com")).rejects.toThrow(
      "Email codes are unavailable.",
    );
  });

  test("restores pending factors, password reset, and transferred signup on remount", () => {
    const emptySignup = { status: "missing_requirements", unverifiedFields: [] };
    expect(
      resumedIdentityStep("sign-in", { id: "si_1", status: "needs_client_trust" }, emptySignup),
    ).toEqual({ step: "factor-select", factorStage: "second" });
    expect(
      resumedIdentityStep("sign-in", { id: "si_1", status: "needs_new_password" }, emptySignup),
    ).toEqual({ step: "new-password" });
    expect(
      resumedIdentityStep(
        "sign-up",
        { status: "needs_identifier" },
        { id: "su_1", status: "missing_requirements", unverifiedFields: ["email_address"] },
      ),
    ).toEqual({ step: "email-code" });
  });

  test("prepares transferred signup email verification before code entry", async () => {
    let sent = false;
    await sendSignUpEmailCode({
      verifications: {
        sendEmailCode: async () => {
          sent = true;
          return { error: null };
        },
      },
    });
    expect(sent).toBe(true);
  });

  test("runs only the selected advertised native factor", async () => {
    const calls: string[] = [];
    const result = (name: string) => async () => {
      calls.push(name);
      return { error: null };
    };
    const signIn = {
      emailCode: { sendCode: result("first-email-send"), verifyCode: result("first-email-verify") },
      phoneCode: { sendCode: result("first-phone-send"), verifyCode: result("first-phone-verify") },
      mfa: {
        sendEmailCode: result("mfa-email-send"),
        sendPhoneCode: result("mfa-phone-send"),
        verifyEmailCode: result("mfa-email-verify"),
        verifyPhoneCode: result("mfa-phone-verify"),
        verifyTOTP: result("mfa-totp-verify"),
        verifyBackupCode: result("mfa-backup-verify"),
      },
      resetPasswordEmailCode: {
        sendCode: result("reset-email-send"),
        verifyCode: result("reset-email-verify"),
      },
      resetPasswordPhoneCode: {
        sendCode: result("reset-phone-send"),
        verifyCode: result("reset-phone-verify"),
      },
    };

    await startNativeFactor(signIn, "second", { strategy: "email_code", emailAddressId: "id_1" });
    await verifyNativeFactor(signIn, "second", "totp", "123456");
    expect(calls).toEqual(["mfa-email-send", "mfa-totp-verify"]);
    expect(errorMessage({ message: "Provider message" })).toBe("Provider message");
  });

  test("keeps factor targets distinct and passes the selected first-factor ID", async () => {
    let emailAddressId = "";
    let phoneTarget: { phoneNumberId?: string; channel?: "sms" | "whatsapp" } = {};
    const noop = async () => ({ error: null });
    const signIn = {
      emailCode: {
        sendCode: async (params?: { emailAddressId?: string }) => {
          emailAddressId = params?.emailAddressId ?? "";
          return { error: null };
        },
        verifyCode: noop,
      },
      phoneCode: {
        sendCode: async (params?: { phoneNumberId?: string; channel?: "sms" | "whatsapp" }) => {
          phoneTarget = params ?? {};
          return { error: null };
        },
        verifyCode: noop,
      },
      mfa: {
        sendEmailCode: noop,
        sendPhoneCode: noop,
        verifyEmailCode: noop,
        verifyPhoneCode: noop,
        verifyTOTP: noop,
        verifyBackupCode: noop,
      },
      resetPasswordEmailCode: { sendCode: noop, verifyCode: noop },
      resetPasswordPhoneCode: { sendCode: noop, verifyCode: noop },
    };
    const factors = nativeFactors([
      { strategy: "email_code", emailAddressId: "id_1", safeIdentifier: "a***@example.com" },
      { strategy: "email_code", emailAddressId: "id_2", safeIdentifier: "b***@example.com" },
      {
        strategy: "phone_code",
        phoneNumberId: "phone_1",
        channel: "sms",
        safeIdentifier: "+1 *** 0100",
      },
      {
        strategy: "phone_code",
        phoneNumberId: "phone_1",
        channel: "whatsapp",
        safeIdentifier: "+1 *** 0100",
      },
      { strategy: "passkey" },
      { strategy: "oauth_google" },
    ]);

    expect(factors).toHaveLength(6);
    const [first, second] = factors;
    if (!first || !second) throw new Error("Expected two email factors.");
    expect(nativeFactorKey(first)).not.toBe(nativeFactorKey(second));
    await startNativeFactor(signIn, "first", second);
    expect(emailAddressId).toBe("id_2");

    const sms = factors.find((factor) => factor.channel === "sms");
    const whatsapp = factors.find((factor) => factor.channel === "whatsapp");
    if (!sms || !whatsapp) throw new Error("Expected SMS and WhatsApp factors.");
    expect(nativeFactorKey(sms)).not.toBe(nativeFactorKey(whatsapp));
    expect(nativeFactorLabel(sms)).toContain("SMS");
    expect(nativeFactorLabel(whatsapp)).toContain("WhatsApp");
    await startNativeFactor(signIn, "first", whatsapp);
    expect(phoneTarget).toEqual({ phoneNumberId: "phone_1", channel: "whatsapp" });
  });
});
