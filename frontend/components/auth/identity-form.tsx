"use client";

import { useClerk, useSignIn, useSignUp } from "@clerk/nextjs";
import { RiLockLine, RiMailLine, RiUserLine } from "@remixicon/react";
import { usePathname, useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Button, ButtonLink } from "@/components/base/buttons/button";
import { Divider } from "@/components/base/divider/divider";
import { Input } from "@/components/base/input/input";
import { SocialButton } from "@/components/base/social-button/social-button";
import { GoogleSignInButton } from "./google-sign-in-button";
import { IdentityFactorChoices } from "./identity-factor-choices";
import {
  type AvailableNativeFactor,
  completeRedirectFlow,
  errorMessage,
  type IdentityFormStep,
  internalRedirect,
  nativeFactors,
  resumedIdentityStep,
  SUPPORTED_SIGN_UP_FIELDS,
  sendSignInEmailCode,
  sendSignUpEmailCode,
  startNativeFactor,
  submitExistingPassword,
  verifyNativeFactor,
} from "./identity-flow";
import {
  IDENTITY_COPY,
  IdentityFormShell,
  type IdentityMode,
  IdentityStatus,
} from "./identity-form-layout";
import { useIdentityMethods } from "./identity-methods";
import { IdentitySessionTasks } from "./identity-session-tasks";

export function IdentityForm({
  mode,
  redirectTo = "/",
}: {
  mode: IdentityMode;
  redirectTo?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const clerk = useClerk();
  const { signIn, fetchStatus: signInStatus } = useSignIn();
  const { signUp, fetchStatus: signUpStatus } = useSignUp();
  const methods = useIdentityMethods();
  const safeRedirect = internalRedirect(redirectTo);
  const callbackRan = useRef(false);
  const ticketRan = useRef(false);
  const signupEmailPrepared = useRef<{ key: string; ready: boolean } | null>(null);

  const [step, setStep] = useState<IdentityFormStep>("start");
  const [factor, setFactor] = useState<AvailableNativeFactor | null>(null);
  const [factorStage, setFactorStage] = useState<"first" | "second">("second");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [legalAccepted, setLegalAccepted] = useState(false);
  const [ticket, setTicket] = useState<string | null>(null);
  const [checkingTicket, setCheckingTicket] = useState(mode === "sign-up");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const navigate = useCallback(
    ({
      session,
      decorateUrl,
    }: {
      session: { currentTask?: { key: string } };
      decorateUrl: (url: string) => string;
    }) => {
      const destination = session.currentTask
        ? `/login/tasks/${encodeURIComponent(session.currentTask.key)}?redirect_url=${encodeURIComponent(safeRedirect)}`
        : safeRedirect;
      const decorated = decorateUrl(destination);
      if (decorated.startsWith("http") && new URL(decorated).origin !== window.location.origin) {
        window.location.assign(decorated);
      } else {
        router.replace(decorated);
      }
    },
    [router, safeRedirect],
  );

  const finishSignIn = useCallback(async () => {
    if (signIn.status !== "complete") return false;
    const { error: finalizeError } = await signIn.finalize({ navigate });
    if (finalizeError) throw new Error(errorMessage(finalizeError));
    return true;
  }, [navigate, signIn]);

  const finishSignUp = useCallback(async () => {
    if (signUp.status !== "complete") return false;
    const { error: finalizeError } = await signUp.finalize({ navigate });
    if (finalizeError) throw new Error(errorMessage(finalizeError));
    return true;
  }, [navigate, signUp]);

  const continueSignIn = useCallback(async () => {
    if (await finishSignIn()) return;
    if (signIn.status === "needs_new_password") {
      setPassword("");
      setStep("new-password");
      return;
    }
    if (signIn.status === "needs_second_factor" || signIn.status === "needs_client_trust") {
      setFactorStage("second");
      setFactor(null);
      setStep("factor-select");
      return;
    }
    throw new Error("Sign-in needs an additional verification step and was not completed.");
  }, [finishSignIn, signIn]);

  const continueSignUp = useCallback(async () => {
    if (await finishSignUp()) return;
    if (signUp.unverifiedFields.includes("email_address")) {
      const key = signUp.id ?? "current";
      signupEmailPrepared.current = { key, ready: false };
      await sendSignUpEmailCode(signUp);
      signupEmailPrepared.current = { key, ready: true };
      setStep("email-code");
      return;
    }
    if (signUp.status === "missing_requirements") {
      setStep("invitation");
      return;
    }
    throw new Error("Account creation could not be completed. Please try again.");
  }, [finishSignUp, signUp]);

  useEffect(() => {
    if (
      !clerk.loaded ||
      signInStatus === "fetching" ||
      signUpStatus === "fetching" ||
      pending ||
      !pathname.endsWith("/sso-callback") ||
      callbackRan.current
    )
      return;
    callbackRan.current = true;
    setPending(true);
    const destination = internalRedirect(
      new URLSearchParams(window.location.search).get("redirect_url"),
    );
    const callbackNavigate = ({
      session,
      decorateUrl,
    }: {
      session: { currentTask?: { key: string } };
      decorateUrl: (url: string) => string;
    }) => {
      const target = session.currentTask
        ? `/login/tasks/${encodeURIComponent(session.currentTask.key)}?redirect_url=${encodeURIComponent(destination)}`
        : destination;
      const decorated = decorateUrl(target);
      if (decorated.startsWith("http") && new URL(decorated).origin !== window.location.origin) {
        window.location.assign(decorated);
      } else {
        router.replace(decorated);
      }
    };
    void completeRedirectFlow({
      signIn,
      signUp,
      setActive: clerk.setActive,
      navigate: callbackNavigate,
    })
      .then((next) => {
        if (next === "sign-in")
          router.replace(`/login?redirect_url=${encodeURIComponent(destination)}`);
        if (next === "sign-up")
          router.replace(`/signup?redirect_url=${encodeURIComponent(destination)}`);
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Sign-in could not be completed."),
      )
      .finally(() => setPending(false));
  }, [clerk.loaded, clerk.setActive, pathname, router, signIn, signInStatus, signUp, signUpStatus]);

  useEffect(() => {
    if (!clerk.loaded || signUpStatus === "fetching" || mode !== "sign-up" || ticketRan.current)
      return;
    ticketRan.current = true;
    const value = new URLSearchParams(window.location.search).get("__clerk_ticket");
    setTicket(value);
    setCheckingTicket(false);
    if (!value) return;
    setPending(true);
    void signUp
      .ticket({ ticket: value })
      .then((result) => {
        if (result.error) throw new Error(errorMessage(result.error));
        return continueSignUp();
      })
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "This invitation could not be accepted."),
      )
      .finally(() => setPending(false));
  }, [clerk.loaded, continueSignUp, mode, signUp, signUpStatus]);

  useEffect(() => {
    if (
      !clerk.loaded ||
      signInStatus === "fetching" ||
      signUpStatus === "fetching" ||
      pending ||
      step !== "start" ||
      pathname.endsWith("/sso-callback") ||
      pathname.includes("/tasks/")
    )
      return;

    const resumed = resumedIdentityStep(mode, signIn, signUp);
    if (!resumed) return;
    if (resumed.step === "email-code") {
      const key = signUp.id ?? "current";
      if (signupEmailPrepared.current?.key === key) {
        if (signupEmailPrepared.current.ready) setStep("email-code");
        return;
      }
      signupEmailPrepared.current = { key, ready: false };
      setPending(true);
      void sendSignUpEmailCode(signUp)
        .then(() => {
          signupEmailPrepared.current = { key, ready: true };
        })
        .catch((cause) =>
          setError(
            cause instanceof Error ? cause.message : "The verification code could not be sent.",
          ),
        )
        .finally(() => {
          setStep("email-code");
          setPending(false);
        });
      return;
    }
    if ("factorStage" in resumed) setFactorStage(resumed.factorStage);
    setStep(resumed.step);
  }, [clerk.loaded, mode, pathname, pending, signIn, signInStatus, signUp, signUpStatus, step]);

  async function startSso(strategy: Parameters<typeof signIn.sso>[0]["strategy"]) {
    setError(null);
    setPending(true);
    try {
      const redirectCallbackUrl = `/login/sso-callback?redirect_url=${encodeURIComponent(safeRedirect)}`;
      const result = await (mode === "sign-in" ? signIn : signUp).sso({
        strategy,
        redirectCallbackUrl,
        redirectUrl: redirectCallbackUrl,
      });
      if (result.error) throw new Error(errorMessage(result.error));
    } catch (cause) {
      setPending(false);
      throw cause;
    }
  }

  async function handleStart(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      if (mode === "sign-in") {
        if (methods.emailPassword) {
          const result = await signIn.password({ emailAddress: email, password });
          if (result.error) throw new Error(errorMessage(result.error));
          await continueSignIn();
          return;
        }
        await sendSignInEmailCode(signIn, email);
        setStep("email-code");
        return;
      }

      if (methods.passwordSignup) {
        const result = await signUp.password({ emailAddress: email, password });
        if (result.error) throw new Error(errorMessage(result.error));
      } else {
        const result = await signUp.create({ emailAddress: email });
        if (result.error) throw new Error(errorMessage(result.error));
      }
      await continueSignUp();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authentication failed. Please try again.");
    } finally {
      setPending(false);
    }
  }

  async function handleEmailCodeInstead() {
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      await sendSignInEmailCode(signIn, email);
      setStep("email-code");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The verification code could not be sent.");
    } finally {
      setPending(false);
    }
  }

  async function startFactor(selected: AvailableNativeFactor) {
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      await startNativeFactor(signIn, factorStage, selected);
      setFactor(selected);
      setCode("");
      setStep("factor-code");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Verification could not be started.");
    } finally {
      setPending(false);
    }
  }

  async function chooseFactor(selected: AvailableNativeFactor) {
    if (selected.strategy === "password") {
      setFactor(selected);
      setPassword("");
      setStep("factor-password");
      return;
    }
    if (selected.strategy.startsWith("oauth_")) {
      try {
        await startSso(selected.strategy as Parameters<typeof signIn.sso>[0]["strategy"]);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Sign-in could not be started.");
      }
      return;
    }
    if (selected.strategy === "passkey") {
      if (pending) return;
      setError(null);
      setPending(true);
      try {
        const result = await signIn.passkey();
        if (result.error) throw new Error(errorMessage(result.error));
        await continueSignIn();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Passkey verification failed.");
      } finally {
        setPending(false);
      }
      return;
    }
    await startFactor(selected);
  }

  async function handleExistingPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      await submitExistingPassword(signIn, password);
      await continueSignIn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The password could not be verified.");
    } finally {
      setPending(false);
    }
  }

  async function handleNewPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      const strategy = signIn.firstFactorVerification.strategy;
      const result =
        strategy === "reset_password_email_code"
          ? await signIn.resetPasswordEmailCode.submitPassword({ password })
          : strategy === "reset_password_phone_code"
            ? await signIn.resetPasswordPhoneCode.submitPassword({ password })
            : null;
      if (!result) throw new Error("Password reset state is unavailable. Start the reset again.");
      if (result.error) throw new Error(errorMessage(result.error));
      if (!(await finishSignIn())) throw new Error("Password reset was not completed.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The new password could not be saved.");
    } finally {
      setPending(false);
    }
  }

  async function resendSignUpEmailCode() {
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      await sendSignUpEmailCode(signUp);
      signupEmailPrepared.current = { key: signUp.id ?? "current", ready: true };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The verification code could not be sent.");
    } finally {
      setPending(false);
    }
  }

  async function handleCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      if (step === "factor-code" && factor) {
        await verifyNativeFactor(signIn, factorStage, factor.strategy, code);
        await continueSignIn();
      } else if (mode === "sign-in") {
        const result = await signIn.emailCode.verifyCode({ code });
        if (result.error) throw new Error(errorMessage(result.error));
        await continueSignIn();
      } else {
        const result = await signUp.verifications.verifyEmailCode({ code });
        if (result.error) throw new Error(errorMessage(result.error));
        await continueSignUp();
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The verification code could not be accepted.",
      );
    } finally {
      setPending(false);
    }
  }

  async function handleInvitation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      const missing = signUp.missingFields;
      const unsupported = missing.filter((field) => !SUPPORTED_SIGN_UP_FIELDS.has(field));
      if (unsupported.length || !missing.some((field) => SUPPORTED_SIGN_UP_FIELDS.has(field))) {
        throw new Error(
          `Additional account requirements are not supported here: ${unsupported.join(", ") || "unknown"}.`,
        );
      }
      if (
        missing.includes("email_address") ||
        missing.includes("first_name") ||
        missing.includes("last_name") ||
        missing.includes("legal_accepted")
      ) {
        const result = await signUp.update({
          ...(missing.includes("first_name") && { firstName }),
          ...(missing.includes("last_name") && { lastName }),
          ...(missing.includes("legal_accepted") && { legalAccepted }),
          ...(missing.includes("email_address") && { emailAddress: email }),
        });
        if (result.error) throw new Error(errorMessage(result.error));
      }
      if (missing.includes("password")) {
        const result = await signUp.password({
          password,
          ...(missing.includes("email_address") && { emailAddress: email }),
        });
        if (result.error) throw new Error(errorMessage(result.error));
      }
      await continueSignUp();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This invitation could not be completed.");
    } finally {
      setPending(false);
    }
  }

  if (pathname.endsWith("/sso-callback")) {
    return (
      <IdentityStatus
        title="Completing sign-in"
        message={error ?? "Finishing your secure sign-in…"}
        error={Boolean(error)}
      />
    );
  }

  if (pathname.includes("/tasks/")) {
    return <IdentitySessionTasks redirectTo={safeRedirect} />;
  }

  if (checkingTicket)
    return <IdentityStatus title="Checking invitation" message="Loading your secure invitation…" />;

  if (step === "factor-select") {
    const factors = nativeFactors(
      factorStage === "second" ? signIn.supportedSecondFactors : signIn.supportedFirstFactors,
    );
    return (
      <IdentityFactorChoices
        factors={factors}
        pending={pending}
        error={error}
        onSelect={(available) => void chooseFactor(available)}
      />
    );
  }

  if (step === "factor-password") {
    return (
      <IdentityFormShell mode="sign-in" error={error}>
        <form className="mt-8 flex flex-col gap-4" onSubmit={handleExistingPassword}>
          <Input
            name="password"
            type="password"
            label="Password"
            autoComplete="current-password"
            leadingIcon={RiLockLine}
            value={password}
            onChange={setPassword}
            isRequired
          />
          <Button type="submit" className="mt-2 w-full" disabled={pending}>
            {pending ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </IdentityFormShell>
    );
  }

  if (step === "new-password") {
    return (
      <IdentityFormShell mode="sign-in" error={error}>
        <form className="mt-8 flex flex-col gap-4" onSubmit={handleNewPassword}>
          <Input
            name="password"
            type="password"
            label="New password"
            autoComplete="new-password"
            leadingIcon={RiLockLine}
            value={password}
            onChange={setPassword}
            isRequired
          />
          <Button type="submit" className="mt-2 h-10 w-full rounded-full" disabled={pending}>
            {pending ? "Saving password…" : "Save new password"}
          </Button>
        </form>
      </IdentityFormShell>
    );
  }

  if (step === "protect-check") {
    return (
      <IdentityStatus
        title="Security check required"
        message="This sign-in needs an additional security check and remains paused safely."
        error
      />
    );
  }

  if (step === "email-code" || step === "factor-code") {
    return (
      <IdentityFormShell mode={mode} error={error}>
        <form className="mt-8 flex flex-col gap-4" onSubmit={handleCode}>
          <Input
            name="code"
            label="Verification code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={setCode}
            isRequired
          />
          <Button type="submit" className="mt-2 h-10 w-full rounded-full" disabled={pending}>
            {pending ? "Verifying…" : "Verify code"}
          </Button>
          {mode === "sign-up" && step === "email-code" && (
            <Button
              type="button"
              variant="ghost"
              className="w-full rounded-full"
              disabled={pending}
              onClick={() => void resendSignUpEmailCode()}
            >
              Send a new code
            </Button>
          )}
        </form>
      </IdentityFormShell>
    );
  }

  if (step === "invitation") {
    const missing = signUp.missingFields;
    const unsupported = missing.filter((field) => !SUPPORTED_SIGN_UP_FIELDS.has(field));
    const canSubmit =
      unsupported.length === 0 && missing.some((field) => SUPPORTED_SIGN_UP_FIELDS.has(field));
    return (
      <IdentityFormShell mode="sign-up" error={error}>
        <form className="mt-8 flex flex-col gap-4" onSubmit={handleInvitation}>
          {missing.includes("email_address") && (
            <Input
              name="email"
              type="email"
              label="Email"
              leadingIcon={RiMailLine}
              value={email}
              onChange={setEmail}
              isRequired
            />
          )}
          {missing.includes("first_name") && (
            <Input
              name="firstName"
              label="First name"
              leadingIcon={RiUserLine}
              value={firstName}
              onChange={setFirstName}
              isRequired
            />
          )}
          {missing.includes("last_name") && (
            <Input
              name="lastName"
              label="Last name"
              leadingIcon={RiUserLine}
              value={lastName}
              onChange={setLastName}
              isRequired
            />
          )}
          {missing.includes("password") && (
            <Input
              name="password"
              type="password"
              label="Password"
              leadingIcon={RiLockLine}
              value={password}
              onChange={setPassword}
              isRequired
            />
          )}
          {missing.includes("legal_accepted") && (
            <label className="flex items-center gap-2 text-body-2-regular text-text-secondary">
              <input
                type="checkbox"
                checked={legalAccepted}
                onChange={(event) => setLegalAccepted(event.target.checked)}
                required
              />
              I agree to the terms and privacy policy
            </label>
          )}
          {canSubmit ? (
            <Button type="submit" className="mt-2 h-10 w-full rounded-full" disabled={pending}>
              {pending
                ? IDENTITY_COPY[mode].pending
                : ticket
                  ? "Accept invitation"
                  : IDENTITY_COPY[mode].submit}
            </Button>
          ) : (
            <p role="alert" className="text-body-2-regular text-text-error-primary">
              Additional account requirements are not supported here:{" "}
              {unsupported.join(", ") || "unknown"}.
            </p>
          )}
          <div id="clerk-captcha" />
        </form>
      </IdentityFormShell>
    );
  }

  const emailEnabled =
    mode === "sign-in" ? methods.emailPassword || methods.emailCode : methods.emailSignup;
  const passwordEnabled = mode === "sign-in" ? methods.emailPassword : methods.passwordSignup;
  const disabled =
    pending || methods.loading || signInStatus === "fetching" || signUpStatus === "fetching";
  const canSignUp = mode === "sign-in" || methods.signupAllowed;

  return (
    <IdentityFormShell mode={mode} error={error ?? methods.error}>
      {canSignUp && (
        <div className="mt-8 flex flex-col gap-3">
          {methods.google && (
            <GoogleSignInButton
              enabled
              disabled={disabled}
              action={() => startSso("oauth_google")}
            />
          )}
          {methods.github && (
            <SocialButton
              brand="github"
              appearance="white"
              fullWidth
              className="h-11 rounded-full"
              disabled={disabled}
              onClick={() =>
                void startSso("oauth_github").catch((cause) =>
                  setError(cause instanceof Error ? cause.message : "Sign-in failed."),
                )
              }
            />
          )}
        </div>
      )}

      {emailEnabled && canSignUp ? (
        <>
          <Divider
            aria-hidden
            className="my-6"
            contentClassName="text-mono-label text-text-tertiary"
          >
            or
          </Divider>
          <form className="flex flex-col gap-4" onSubmit={handleStart} noValidate>
            <Input
              name="email"
              type="email"
              label="Email"
              placeholder="you@company.com"
              autoComplete="email"
              leadingIcon={RiMailLine}
              value={email}
              onChange={setEmail}
              isRequired
            />
            {passwordEnabled && (
              <Input
                name="password"
                type="password"
                label="Password"
                placeholder="••••••••"
                autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
                leadingIcon={RiLockLine}
                value={password}
                onChange={setPassword}
                isRequired
              />
            )}
            <Button type="submit" className="mt-2 w-full" disabled={disabled}>
              {pending
                ? IDENTITY_COPY[mode].pending
                : passwordEnabled
                  ? IDENTITY_COPY[mode].submit
                  : "Email me a code"}
            </Button>
            {mode === "sign-in" && methods.emailPassword && methods.emailCode && (
              <Button
                type="button"
                variant="ghost"
                className="w-full rounded-full"
                disabled={disabled || !email}
                onClick={() => void handleEmailCodeInstead()}
              >
                Email me a code instead
              </Button>
            )}
          </form>
        </>
      ) : (
        !methods.loading &&
        !methods.error && (
          <p className="mt-6 text-body-2-regular text-text-tertiary">
            {canSignUp
              ? "Email sign-in isn't enabled for this workspace."
              : "Self-service signup isn't enabled for this workspace."}
          </p>
        )
      )}

      {(mode === "sign-up" || methods.signupAllowed) && (
        <p className="mt-6 text-center text-body-2-regular text-text-secondary">
          {mode === "sign-in" ? "New to useAgent? " : "Already have an account? "}
          <ButtonLink
            href={`${mode === "sign-in" ? "/signup" : "/login"}?redirect_url=${encodeURIComponent(safeRedirect)}`}
            variant="ghost"
            className="inline h-auto rounded-full p-0 text-text-accent"
          >
            {mode === "sign-in" ? "Create account" : "Sign in"}
          </ButtonLink>
        </p>
      )}
      {mode === "sign-up" && <div id="clerk-captcha" />}
    </IdentityFormShell>
  );
}
