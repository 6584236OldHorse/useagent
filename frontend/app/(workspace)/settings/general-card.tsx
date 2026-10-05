"use client";

import { useEffect, useState } from "react";
import { listWorkspaces, useSession } from "@/lib/auth";
import { cx } from "@/utils/cx";
import { ThemeToggle } from "./theme-toggle";
import { SettingsCard, SettingsRow } from "./settings-rows";

/**
 * General card - profile details read from the live better-auth session and
 * the workspace's name from the same workspace list the user menu reads, so a
 * rename (the welcome page) shows here. Nothing here is editable, so the
 * values render as text ("Not set" when there is none) rather than as inputs
 * that ignore typing. Client component because ThemeToggle can't cross the
 * server boundary.
 */

export const AVATAR_GRADIENT = "bg-gradient-to-br from-purple-400 to-blue-500 text-white";

/** A read-only value; `null` while the session is still loading. */
function Value({ value }: { value: string | null }) {
  if (value === null) return null;
  return (
    <p className={cx("text-body-2-regular", value ? "text-text-primary" : "text-text-secondary")}>
      {value || "Not set"}
    </p>
  );
}

/** The name of the workspace the session is in; null when the list names none,
 *  which the card reports as a failed read rather than an unset name. */
export function activeWorkspaceName(workspaces: readonly { active: boolean; name: string }[]): string | null {
  return workspaces.find((row) => row.active)?.name ?? null;
}

export function GeneralCard({ initialWorkspaceName }: { initialWorkspaceName?: string } = {}) {
  const { session, loading } = useSession();
  const name = loading ? null : (session?.user.name?.trim() ?? "");
  const email = loading ? null : (session?.user.email ?? "");
  /** The active workspace's name; null while it loads. */
  const [workspaceName, setWorkspaceName] = useState<string | null>(initialWorkspaceName ?? null);
  const [workspaceFailed, setWorkspaceFailed] = useState(false);

  useEffect(() => {
    if (initialWorkspaceName !== undefined) return;
    let cancelled = false;
    listWorkspaces()
      .then((workspaces) => {
        if (cancelled) return;
        const active = activeWorkspaceName(workspaces);
        if (active === null) setWorkspaceFailed(true);
        else setWorkspaceName(active);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [initialWorkspaceName]);

  return (
    <SettingsCard>
      <SettingsRow label="Name">
        <Value value={name} />
      </SettingsRow>
      <SettingsRow label="Email">
        <Value value={email} />
      </SettingsRow>
      <SettingsRow label="Workspace name">
        {workspaceFailed ? (
          <p className="text-body-2-regular text-text-error-primary">Could not load the workspace.</p>
        ) : (
          <Value value={workspaceName} />
        )}
      </SettingsRow>
      <SettingsRow label="Theme" description="Choose your interface theme.">
        <ThemeToggle />
      </SettingsRow>
    </SettingsCard>
  );
}
