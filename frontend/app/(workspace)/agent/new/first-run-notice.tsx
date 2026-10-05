"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { listWorkspaces, useSession } from "@/lib/auth";
import { markFirstRunSkipped, watchFirstRun } from "@/lib/first-run";

/**
 * The composer page's first-run notice: a compact card above the composer
 * when the workspace created with the account still carries its default name
 * and has nobody else in it. The composer is interactive from the first
 * paint and nothing here navigates: "Set up your workspace" is a plain link
 * to /welcome the person follows themselves, and Continue records the choice
 * for this browser and hides the card. The account menu offers the page too.
 */

export function FirstRunCard({ onContinue }: { onContinue: () => void }) {
  return (
    <div
      role="status"
      data-testid="first-run-card"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-border-button-default bg-background-primary-default px-4 py-3"
    >
      <p className="min-w-0 flex-1 text-body-2-regular text-text-secondary">
        <span className="text-body-2-medium text-text-primary">Your workspace is not set up yet.</span> Name it and
        invite your team whenever you like.
      </p>
      <Link
        href="/welcome"
        className="rounded-full border border-border-button-default px-3 py-1 text-caption-1-medium text-text-primary hover:bg-background-primary-hover"
      >
        Set up your workspace
      </Link>
      <Button variant="ghost" size="xs" onClick={onContinue}>
        Continue
      </Button>
    </div>
  );
}

export function FirstRunNotice({ initialFirstRun }: { initialFirstRun?: boolean }) {
  const { session, loading } = useSession();
  const [firstRun, setFirstRun] = useState(initialFirstRun ?? false);

  useEffect(() => {
    if (initialFirstRun !== undefined || loading || !session) return;
    return watchFirstRun({ userId: session.user.id, listWorkspaces, settle: setFirstRun });
  }, [initialFirstRun, loading, session]);

  if (!firstRun) return null;
  return (
    <FirstRunCard
      onContinue={() => {
        if (session) markFirstRunSkipped(session.user.id);
        setFirstRun(false);
      }}
    />
  );
}
