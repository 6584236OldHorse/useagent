"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/base/buttons/button";

/** Seconds before the link can be asked for again; the server counts attempts too. */
export const RESEND_COOLDOWN_S = 60;

/** What the server said about the mail, or what a sign-up's answer implies. */
export type MailStatus =
  /** A sign-up: the server answers the same for a new address and for one that already has an account. */
  | { readonly kind: "if_new" }
  | { readonly kind: "sent" }
  | { readonly kind: "held"; readonly retryAfterSeconds: number }
  | { readonly kind: "closed" };

/** The truth about the mail, in plain words. */
export function mailText(email: string, status: MailStatus): string {
  switch (status.kind) {
    case "if_new":
      return `If ${email} is new here, a confirmation link is on its way: open it, then sign in. If the address already has an account, sign in with your password instead; a link is not sent to an address that is already confirmed.`;
    case "sent":
      return `A confirmation link is on its way to ${email}. Open it, then sign in. It works for one hour.`;
    case "held":
      return `${email} has had its share of confirmation links this hour. Use the newest one you received, or ask again in ${Math.max(1, Math.ceil(status.retryAfterSeconds / 60))} minutes.`;
    case "closed":
      return `${email} has a sign-up that was never confirmed, and sign-up is closed on this server now. Ask an administrator for an invitation.`;
  }
}

/**
 * The card an account lands on while its address is unconfirmed. Asking again
 * repeats the request that led here (the credentials prove it is the same
 * person); the parent runs it and reports what the server said about the mail,
 * or a problem in plain words.
 */
export function CheckYourEmail({
  email,
  mail,
  onResend,
  onBack,
}: {
  email: string;
  mail: MailStatus;
  onResend: () => Promise<{ mail: MailStatus } | { problem: string }>;
  onBack: () => void;
}) {
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_S);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<MailStatus>(mail);
  const [problem, setProblem] = useState<string | null>(null);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((left) => left - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const resend = async () => {
    setSending(true);
    setProblem(null);
    const outcome = await onResend();
    setSending(false);
    if ("problem" in outcome) setProblem(outcome.problem);
    else {
      setStatus(outcome.mail);
      setAsked(true);
    }
    setCooldown(RESEND_COOLDOWN_S);
  };

  const canAskAgain = status.kind !== "closed";
  return (
    <div className="mx-auto w-full max-w-[360px]">
      <h1 className="text-title-2-medium text-text-primary">
        {status.kind === "closed" ? "Sign-up is closed" : "Check your email"}
      </h1>
      <p role="status" className="mt-1.5 text-body-regular text-text-secondary">
        {asked ? "Asked again. " : ""}
        {mailText(email, status)}
      </p>
      {problem && (
        <p role="alert" className="mt-4 text-body-2-regular text-text-error-primary">
          {problem}
        </p>
      )}
      <div className="mt-6 flex flex-wrap gap-2">
        {canAskAgain && (
          <Button variant="secondary" size="small" disabled={cooldown > 0 || sending} onClick={() => void resend()}>
            {sending ? "Asking..." : cooldown > 0 ? `Ask again in ${cooldown}s` : "Send the link again"}
          </Button>
        )}
        <Button variant="ghost" size="small" onClick={onBack}>
          Back to sign in
        </Button>
      </div>
    </div>
  );
}
