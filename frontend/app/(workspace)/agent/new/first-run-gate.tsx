"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { listWorkspaces, useSession } from "@/lib/auth";
import { type LandingDecision, settleLanding, watchLanding } from "@/lib/first-run";

/**
 * Gates the composer behind the first-run check: nothing a person could type
 * into is rendered until the check has settled, the first-run page opens only
 * from that pre-render state, and once the composer is up nothing navigates
 * away from it. Signed-out (dev-org) visitors and people who chose to
 * continue before are let straight through; the account menu still offers the
 * page while the workspace is on its first run.
 */
export function FirstRunGate({
  children,
  initialDecision = "pending",
}: {
  children: ReactNode;
  /** Tests start from a settled state; the page always starts pending. */
  initialDecision?: LandingDecision;
}) {
  const router = useRouter();
  const { session, loading } = useSession();
  const [decision, setDecision] = useState<LandingDecision>(initialDecision);

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
