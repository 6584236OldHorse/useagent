"use client";

// Vendored from T3 Code (https://t3.chat - T3 Tools Inc), MIT License.
// Copyright (c) 2026 T3 Tools Inc. Upstream commit 7c1bdd6e1.
//
// Source: apps/web/src/components/chat/ThreadErrorBanner.tsx (the prominent
// dismissible thread-failure alert + its session-scoped dismissal helpers: a
// dismissal is remembered per thread key + message, so navigating away to a
// thread with no error cannot resurrect the banner, while a DIFFERENT error on
// the same thread still appears).
//
// Port notes:
// - Their shadcn Alert/Button/Tooltip -> hand-rolled with our error tokens
//   (bg-red-50 / border-red-200 / text-text-error-primary), matching the
//   other session-ui ports; lucide CircleAlertIcon/XIcon -> Remixicon.
// - Their line-clamp + Tooltip full-text affordance -> the whole reason, wrapped,
//   plus a copy affordance (the backend already slices the reason; the banner
//   must not hide any more of it).
// - Their Retry -> Resend (`resend`): it sends the failed prompt again as a new
//   turn (POST /api/runs/:id/resend) and renders only when the caller passes it.

import { RiCloseLine, RiErrorWarningLine, RiRestartLine } from "@remixicon/react";
import { Button } from "@/components/base/buttons/button";
import { MessageCopyButton } from "@/components/session-ui/message-copy-button";

/** The Resend action for the failed run: the click, whether a resend is in
 *  flight, and why the last one was refused. */
export interface ThreadErrorResend {
  readonly onResend: () => void;
  readonly pending: boolean;
  readonly error: string | null;
}

export function getThreadErrorBannerKey(threadKey: string, error: string | null): string | null {
  return error === null ? null : `${threadKey}\u0000${error}`;
}

/** A deliberate user cancel is a neutral outcome, never an alarm. */
export function isUserStopSummary(error: string | null): boolean {
  return error !== null && /^stopped by user/i.test(error.trim());
}

/** The banner belongs to the thread's LATEST turn only. A failure an earlier
 *  turn already recovered from (the next turn completed) must not render under
 *  that newer, successful turn as if the new work had failed. */
export function latestTurnFailure<T extends { status: string; summary: string | null }>(
  turns: readonly T[],
): T | undefined {
  const newest = turns.at(-1);
  return newest?.status === "failed" && newest.summary ? newest : undefined;
}

export function shouldShowThreadErrorBanner(
  threadKey: string,
  error: string | null,
  isDismissed: boolean,
): boolean {
  if (isUserStopSummary(error)) return false;
  return getThreadErrorBannerKey(threadKey, error) !== null && !isDismissed;
}

// Session-scoped (module-level so it survives session-view remounts, e.g. route
// changes between threads). A dismissal is remembered per thread key plus
// message, so a different error message on the same thread still appears.
const sessionDismissedThreadErrorBannerKeys = new Set<string>();

export function dismissThreadErrorBannerForSession(bannerKey: string | null): void {
  if (bannerKey !== null) {
    sessionDismissedThreadErrorBannerKeys.add(bannerKey);
  }
}

export function isThreadErrorBannerDismissedForSession(bannerKey: string | null): boolean {
  return bannerKey !== null && sessionDismissedThreadErrorBannerKeys.has(bannerKey);
}

/**
 * Prominent dismissible banner for a thread whose latest run FAILED: error glyph
 * + "This run failed" + the run's real error summary (run.summary). Purely
 * presentational; the call site computes visibility (failed latest run + the
 * session-dismissal helpers above) from thread-store state it already has.
 */
export function ThreadErrorBanner({
  error,
  onDismiss,
  resend,
}: {
  /** The failed run's real error summary (run.summary); null renders nothing. */
  error: string | null;
  onDismiss?: () => void;
  /** Renders a Resend action; absent means no button. */
  resend?: ThreadErrorResend;
}) {
  if (!error) return null;
  return (
    <div
      data-session-ui="thread-error-banner"
      role="alert"
      className="border-border-error-default/60 bg-background-secondary-default flex items-start gap-2.5 rounded-lg border px-3 py-2.5"
    >
      <RiErrorWarningLine className="text-text-error-primary mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-body-2-regular text-text-secondary whitespace-pre-wrap break-words">
          <span className="text-body-2-medium text-text-error-primary">Run failed</span>
          <span className="text-text-tertiary"> - </span>
          {error}
        </p>
        {resend?.error && (
          <p className="text-caption-1-regular text-text-error-primary mt-1">{resend.error}</p>
        )}
      </div>
      <MessageCopyButton text={error} label="Copy error" />
      {resend && (
        <Button
          variant="secondary"
          size="xs"
          leadingIcon={RiRestartLine}
          className="shrink-0 rounded-full"
          disabled={resend.pending}
          onClick={resend.onResend}
        >
          {resend.pending ? "Resending" : "Resend"}
        </Button>
      )}
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss error"
          onClick={onDismiss}
          className="text-text-tertiary hover:text-text-primary hover:bg-background-tertiary-hover flex size-6 shrink-0 items-center justify-center rounded-md transition-colors"
        >
          <RiCloseLine className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
