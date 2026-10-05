"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { assignableRoles, InviteDialog } from "@/app/(workspace)/settings/team-card";
import {
  fetchInvitations,
  type PendingInvitation,
  renameWorkspace,
} from "@/app/(workspace)/settings/team-api";
import { AuthScreen } from "@/components/auth/auth-screen";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { ROLE_LABEL, listWorkspaces, useAuthConfig, useSession, type Workspace } from "@/lib/auth";
import { firstRunApplies, markFirstRunSkipped } from "@/lib/first-run";

/**
 * The first-run page: a person who lands in the workspace created with their
 * account, still carrying its default name and with nobody else in it, names
 * it and invites teammates. Both can change later in Settings. The sandbox
 * provider is not asked about (the deployment default and the desktop runner
 * cover it), and there is no allowance figure until a spend read exists.
 */

export interface FirstRun {
  readonly workspace: Workspace;
  readonly invitations: readonly PendingInvitation[];
}

/** Null when the person is not on a first run: the landing page is the place for them. */
async function loadFirstRun(): Promise<FirstRun | null> {
  const [workspaces, { invitations }] = await Promise.all([listWorkspaces(), fetchInvitations()]);
  const workspace = workspaces.find((row) => row.active);
  return firstRunApplies(workspace) ? { workspace, invitations } : null;
}

export function FirstRunSetup({ initial }: { initial?: FirstRun | null }) {
  const router = useRouter();
  const { session, loading } = useSession();
  const config = useAuthConfig();
  const [state, setState] = useState<FirstRun | null | undefined>(initial);
  const [name, setName] = useState(initial?.workspace.name ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  useEffect(() => {
    if (initial !== undefined || loading) return;
    if (!session) {
      router.replace("/login?redirect_url=%2Fwelcome");
      return;
    }
    let cancelled = false;
    loadFirstRun()
      .then((next) => {
        if (cancelled) return;
        setState(next);
        if (next) setName(next.workspace.name);
      })
      .catch(() => {
        if (!cancelled) setState(null);
      });
    return () => {
      cancelled = true;
    };
  }, [initial, loading, router, session]);

  useEffect(() => {
    if (state === null) router.replace("/");
  }, [router, state]);

  if (!state) {
    return (
      <AuthScreen>
        <p role="status" className="text-body-2-regular text-text-secondary">
          Preparing your workspace...
        </p>
      </AuthScreen>
    );
  }

  const { workspace, invitations } = state;
  const trimmed = name.trim();
  const canSave = trimmed !== "" && trimmed !== workspace.name && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await renameWorkspace(workspace.id, trimmed);
      setState({ ...state, workspace: { ...workspace, name: trimmed, defaultName: false } });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename the workspace.");
    } finally {
      setSaving(false);
    }
  };

  const refreshInvitations = async () => {
    try {
      const next = await fetchInvitations();
      setState((current) => (current ? { ...current, invitations: next.invitations } : current));
    } catch {
      // The dialog already showed the invitation; the list catches up on the next load.
    }
  };

  const continueToWorkspace = () => {
    if (session) markFirstRunSkipped(session.user.id);
    router.replace("/");
  };

  return (
    <AuthScreen>
      <div className="flex flex-col gap-8">
        <div>
          <h1 className="text-display-md text-text-primary">Welcome to useAgent</h1>
          <p className="mt-2 text-body-regular text-text-secondary">
            Name your workspace and bring your team. Both can change later in Settings.
          </p>
        </div>

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Input
            label="Workspace name"
            value={name}
            onChange={(next) => {
              setName(next);
              setSaved(false);
            }}
            isRequired
            isInvalid={error !== null}
            hint={error ?? (saved ? "Saved." : undefined)}
          />
          <div>
            <Button type="submit" variant="secondary" size="small" className="rounded-full" disabled={!canSave}>
              {saving ? "Saving..." : "Save name"}
            </Button>
          </div>
        </form>

        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-body-medium text-text-primary">Teammates</h2>
            <p className="mt-1 text-caption-1-regular text-text-secondary">
              Admins manage people, secrets and machines. Members run work.
            </p>
          </div>
          {invitations.length > 0 && (
            <ul className="flex flex-col">
              {invitations.map((row) => (
                <li
                  key={row.id}
                  className="flex items-center justify-between gap-3 border-b border-separator-border py-2 last:border-b-0"
                >
                  <span className="truncate text-body-2-regular text-text-primary">{row.email}</span>
                  <span className="shrink-0 text-caption-1-regular text-text-tertiary">
                    {ROLE_LABEL[row.role]}, invited
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button variant="secondary" size="small" className="rounded-full" onClick={() => setInviting(true)}>
              Invite a teammate
            </Button>
          </div>
        </section>

        <div>
          <Button variant="primary" size="small" className="rounded-full" onClick={continueToWorkspace}>
            Continue to workspace
          </Button>
        </div>
      </div>

      <InviteDialog
        open={inviting}
        onOpenChange={setInviting}
        organizationId={workspace.id}
        roles={assignableRoles(workspace.role)}
        emailDelivery={config?.invitationEmail ?? null}
        onInvited={() => void refreshInvitations()}
      />
    </AuthScreen>
  );
}
