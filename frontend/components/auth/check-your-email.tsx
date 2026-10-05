"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/base/buttons/button";

/** Seconds before the link can be asked for again; the server counts attempts too. */
export const RESEND_COOLDOWN_S = 60;

/**
 * The card an open sign-up lands on: the account exists and waits for its
 * mail. Asking again repeats the request that produced the mail (the
 * credentials prove it is the same person), so the parent supplies it and
 * reports a problem in plain words, or nothing.
 */
export function CheckYourEmail({
  email,
  onResend,
  onBack,
}: {
  email: string;
  onResend: () => Promise<string | null>;
  onBack: () => void;
}) {
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_S);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "problem"; text: string } | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((left) => left - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const resend = async () => {
    setSending(true);
    setStatus(null);
    const problem = await onResend();
    setSending(false);
    setStatus(problem ? { tone: "problem", text: problem } : { tone: "ok", text: "Sent again. Check your inbox and spam folder." });
    setCooldown(RESEND_COOLDOWN_S);
  };

  return (
    <div className="mx-auto w-full max-w-[360px]">
      <h1 className="text-title-2-medium text-text-primary">Check your email</h1>
      <p className="mt-1.5 text-body-regular text-text-secondary">
        We sent a confirmation link to <span className="text-text-primary">{email}</span>. Open it to
        finish, then sign in. The link works for one hour.
      </p>
      {status && (
        <p
          role={status.tone === "problem" ? "alert" : "status"}
          className={`mt-4 text-body-2-regular ${status.tone === "problem" ? "text-text-error-primary" : "text-text-secondary"}`}
        >
          {status.text}
        </p>
      )}
      <div className="mt-6 flex flex-wrap gap-2">
        <Button variant="secondary" size="small" disabled={cooldown > 0 || sending} onClick={() => void resend()}>
          {sending ? "Sending..." : cooldown > 0 ? `Resend in ${cooldown}s` : "Resend link"}
        </Button>
        <Button variant="ghost" size="small" onClick={onBack}>
          Back to sign in
        </Button>
      </div>
    </div>
  );
}
