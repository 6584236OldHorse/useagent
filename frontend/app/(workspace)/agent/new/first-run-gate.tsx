"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
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
  /** A navigation was requested from this page while the check was pending. */
  const leaving = useRef(false);

  // A task can arrive while the check is pending (a project's "New thread"
  // changes only the query, and state survives that): settle on the composer
  // and, through the effect below keyed on the decision, cancel the watcher.
  useEffect(() => {
    if (prefilled) setDecision((current) => settleLanding(current, "stay"));
  }, [prefilled]);

  // Any activation on the page while the check is pending (a click, Enter or
  // Space on a link, a menu item, a button) may be a navigation whose page has
  // not rendered yet; it is recorded here, in the capture phase, before the
  // handler that asks the router, so the check's answer can no longer open
  // the first-run page over it.
  useEffect(() => {
    if (decision !== "pending") return;
    const mark = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Enter" && event.key !== " ") return;
      leaving.current = true;
      setDecision((current) => settleLanding(current, "stay"));
    };
    document.addEventListener("click", mark, true);
    document.addEventListener("keydown", mark, true);
    return () => {
      document.removeEventListener("click", mark, true);
      document.removeEventListener("keydown", mark, true);
    };
  }, [decision]);

  useEffect(() => {
    if (decision !== "pending" || loading) return;
    if (!session) {
      setDecision("stay");
      return;
    }
    const startedAt = window.location.pathname + window.location.search;
    return watchLanding({
      userId: session.user.id,
      listWorkspaces,
      settle: (outcome) => setDecision((current) => settleLanding(current, outcome)),
      stillHere: () => !leaving.current && window.location.pathname + window.location.search === startedAt,
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
