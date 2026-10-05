"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { listWorkspaces, useSession } from "@/lib/auth";
import { type LandingDecision, settleLanding, watchLanding } from "@/lib/first-run";

/**
 * Gates the composer behind the first-run check: nothing a person could type
 * into is rendered until the check has settled, the first-run page opens only
 * from that pre-render state, and once the composer is up nothing navigates
 * away from it. Signed-out (dev-org) visitors, people who chose to continue
 * before, and a URL that already carries a task (a deep link from the desktop
 * app, a bookmark, the CLI) are let straight through: the person came to do
 * something, and the account menu still offers the page while the workspace
 * is on its first run.
 */

/** Whether the URL the page was opened with already names a task: a prompt or
 *  a repository (the parameters the page reads); blank values do not count. */
export function taskPrefilled(task: { readonly repo: string | null; readonly prompt: string }): boolean {
  return Boolean(task.repo) || task.prompt.trim() !== "";
}

export function FirstRunGate({
  children,
  prefilled = false,
  initialDecision,
}: {
  children: ReactNode;
  /** The URL carries a task: render the composer at once, no check. */
  prefilled?: boolean;
  /** Tests start from a settled state; the page starts pending unless prefilled. */
  initialDecision?: LandingDecision;
}) {
  const router = useRouter();
  const { session, loading } = useSession();
  const [decision, setDecision] = useState<LandingDecision>(initialDecision ?? (prefilled ? "stay" : "pending"));

  useEffect(() => {
    if (decision !== "pending" || loading) return;
    if (!session) {
      setDecision("stay");
      return;
    }
    return watchLanding({
      userId: session.user.id,
      listWorkspaces,
      settle: (outcome) => setDecision((current) => settleLanding(current, outcome)),
    });
  }, [decision, loading, session]);

  useEffect(() => {
    if (decision === "open") router.replace("/welcome");
  }, [decision, router]);

  if (decision !== "stay") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="rounded-2xl border border-border-button-default bg-background-primary-default px-4 py-6 text-center text-body-2-regular text-text-tertiary"
      >
        Preparing your workspace...
      </div>
    );
  }
  return <>{children}</>;
}
