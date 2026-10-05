"use client";

import { useCallback, useState } from "react";
import type { ThreadErrorResend } from "@/components/session-ui/thread-error-banner";
import { resendRun, runCreateFailureMessage } from "@/lib/create-run";

const RESEND_FAILED = "Couldn't resend this message. Try again.";

/** One Resend click: its own idempotency key (a lost response retries with the
 *  same one), then null when accepted or the reason it was refused. */
export async function requestResend(runId: string): Promise<string | null> {
  try {
    const response = await resendRun(runId);
    return response.ok ? null : await runCreateFailureMessage(response, RESEND_FAILED);
  } catch {
    return RESEND_FAILED;
  }
}

/** Resend for the thread's failed latest run. The button stays pending after an
 *  accepted click: the new run reaches the thread through its stream, which
 *  retires this failure (and so this run id) instead of offering a second send. */
export function useResendRun(runId: string | null): ThreadErrorResend | undefined {
  const [state, setState] = useState<{ runId: string; pending: boolean; error: string | null } | null>(null);
  const current = state?.runId === runId ? state : null;
  const pending = current?.pending ?? false;
  const onResend = useCallback(async () => {
    if (!runId || pending) return;
    setState({ runId, pending: true, error: null });
    const error = await requestResend(runId);
    if (error) setState({ runId, pending: false, error });
  }, [runId, pending]);
  if (!runId) return undefined;
  return { onResend, pending, error: current?.error ?? null };
}
