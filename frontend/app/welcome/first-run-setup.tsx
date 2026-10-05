"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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

export type FirstRunLoad =
  /** On a first run; invitations are undefined while they load and null when
   *  their read failed or answered for another workspace. */
  | {
      readonly kind: "ready";
      readonly workspace: Workspace;
      readonly invitations: readonly PendingInvitation[] | null | undefined;
    }
  /** The workspace read succeeded and says the landing page is the place for this person. */
  | { readonly kind: "not-first-run" }
  /** The workspace read failed; the page stays and offers a retry and a way on. */
  | { readonly kind: "unavailable" };

type InvitationsRead = () => Promise<{ organizationId: string; invitations: PendingInvitation[] }>;

/** The workspace's pending invitations, or null when the read failed or the
 *  active workspace changed between the two requests (a mismatched answer is
 *  dropped rather than shown under the wrong name). */
export async function invitationsFor(
  workspaceId: string,
  read: InvitationsRead = fetchInvitations,
): Promise<readonly PendingInvitation[] | null> {
  try {
    const { organizationId, invitations } = await read();
    return organizationId === workspaceId ? invitations : null;
  } catch {
    return null;
  }
}

/** What /welcome shows, from the workspace read alone. Only a read that
 *  succeeds and says "not a first run" sends the person to the landing page; a
 *  failed read renders here, so a failing request can never bounce them
 *  between the landing page (whose own check succeeds) and this one. The
 *  invitations load beside the page afterwards and never hold it up. */
export async function resolveFirstRun(
  read: () => Promise<Workspace[]> = listWorkspaces,
): Promise<FirstRunLoad> {
  let workspaces: Workspace[];
  try {
    workspaces = await read();
  } catch {
    return { kind: "unavailable" };
  }
  const workspace = workspaces.find((row) => row.active);
  if (!firstRunApplies(workspace)) return { kind: "not-first-run" };
  return { kind: "ready", workspace, invitations: undefined };
}

export function FirstRunSetup({ initial }: { initial?: FirstRunLoad }) {
  const router = useRouter();
  const { session, loading } = useSession();
  const config = useAuthConfig();
  const [state, setState] = useState<FirstRunLoad | undefined>(initial);
  const [attempt, setAttempt] = useState(0);
  const [name, setName] = useState(initial?.kind === "ready" ? initial.workspace.name : "");
  const typed = useRef(name);
  typed.current = name;
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  useEffect(() => {
    if ((initial !== undefined && attempt === 0) || loading) return;
    if (!session) {
      router.replace("/login?redirect_url=%2Fwelcome");
      return;
    }
    let cancelled = false;
    setState(undefined);
    void resolveFirstRun().then(async (next) => {
      if (cancelled) return;
      setState(next);
      if (next.kind !== "ready") return;
      setName(next.workspace.name);
      const invitations = await invitationsFor(next.workspace.id);
      if (!cancelled) setState((current) => (current?.kind === "ready" ? { ...current, invitations } : current));
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, initial, loading, router, session]);

  useEffect(() => {
    if (state?.kind === "not-first-run") router.replace("/");
  }, [router, state]);

  const continueToWorkspace = () => {
    if (session) markFirstRunSkipped(session.user.id);
    router.replace("/");
  };

  if (state === undefined || state.kind === "not-first-run") {
    return (
      <AuthScreen>
        <p role="status" className="text-body-2-regular text-text-secondary">
          Preparing your workspace...
        </p>
      </AuthScreen>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <AuthScreen>
        <div className="flex flex-col gap-4">
          <p role="alert" className="text-body-2-regular text-text-error-primary">
            Could not load your workspace. Check your connection and try again.
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" size="small" className="rounded-full" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
            <Button variant="ghost" size="small" className="rounded-full" onClick={continueToWorkspace}>
              Continue to workspace
            </Button>
          </div>
        </div>
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
      // A functional update: an invitation refresh that landed meanwhile stays.
      setState((current) =>
        current?.kind === "ready"
          ? { ...current, workspace: { ...current.workspace, name: trimmed, defaultName: false } }
          : current,
      );
      // Typing during the save leaves unsaved text in the field: no "Saved" beside it.
      if (typed.current.trim() === trimmed) setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename the workspace.");
    } finally {
      setSaving(false);
    }
  };

  const refreshInvitations = async () => {
    const next = await invitationsFor(workspace.id);
    setState((current) => (current?.kind === "ready" ? { ...current, invitations: next } : current));
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
          {invitations === undefined ? (
            <p role="status" className="text-caption-1-regular text-text-tertiary">
              Loading invitations...
            </p>
          ) : invitations === null ? (
            <div className="flex items-center gap-3">
              <p role="alert" className="text-caption-1-regular text-text-error-primary">
                Could not load the invitations.
              </p>
              <Button variant="ghost" size="xs" onClick={() => void refreshInvitations()}>
                Try again
              </Button>
            </div>
          ) : invitations.length > 0 ? (
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
          ) : null}
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
