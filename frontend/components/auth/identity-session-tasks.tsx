"use client";

import { useClerk, useOrganizationList } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { Select, SelectItem } from "@/components/base/select/select";
import { internalRedirect } from "./identity-flow";

type SessionState = {
  status: string;
  currentTask?: { key: string };
};

export function sessionTaskDestination(session: SessionState, redirectTo: string): string | null {
  if (session.currentTask) {
    return `/login/tasks/${encodeURIComponent(session.currentTask.key)}?redirect_url=${encodeURIComponent(internalRedirect(redirectTo))}`;
  }
  return session.status === "active" ? internalRedirect(redirectTo) : null;
}

export function shouldFetchNextOrganizationPage({
  taskKey,
  loaded,
  hasNextPage,
  isFetching,
  isError,
}: {
  taskKey?: string;
  loaded: boolean;
  hasNextPage: boolean;
  isFetching: boolean;
  isError: boolean;
}) {
  return taskKey === "choose-organization" && loaded && hasNextPage && !isFetching && !isError;
}

export function mfaRecoveryDestination(
  session: SessionState,
  redirectTo: string,
  acknowledged: boolean,
) {
  return acknowledged ? sessionTaskDestination(session, redirectTo) : null;
}

export function hasPendingMfaRecoveryAcknowledgement(
  sessionId: string | undefined,
  read: (key: string) => string | null,
) {
  return Boolean(sessionId && read(`useagent:mfa-recovery-ack:${sessionId}`) === "pending");
}

export async function signOutBeforeClearingRecoveryMarker(
  signOut: () => Promise<unknown>,
  clearMarker: () => void,
) {
  await signOut();
  clearMarker();
}

export async function verifyTotpWithPendingRecoveryAcknowledgement<T>({
  markPending,
  verify,
}: {
  markPending: () => void;
  verify: () => Promise<T>;
}) {
  markPending();
  return verify();
}

export function IdentitySessionTasks({ redirectTo }: { redirectTo: string }) {
  const clerk = useClerk();
  const router = useRouter();
  const organizations = useOrganizationList({
    userMemberships: { infinite: true, pageSize: 100 },
  });
  const [selectedOrganization, setSelectedOrganization] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmedPassword, setConfirmedPassword] = useState("");
  const [totpSecret, setTotpSecret] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [generatedRecoveryCodes, setGeneratedRecoveryCodes] = useState<string[]>([]);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [verifiedMfaSessionId, setVerifiedMfaSessionId] = useState<string | null>(null);
  const [recoveryAcknowledgementPending, setRecoveryAcknowledgementPending] = useState(false);
  const [checkedRecoverySessionId, setCheckedRecoverySessionId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = clerk.loaded ? clerk.session : undefined;
  const task = session?.currentTask;

  useEffect(() => {
    if (!session?.id) return;
    try {
      const markerPending = hasPendingMfaRecoveryAcknowledgement(session.id, (key) =>
        sessionStorage.getItem(key),
      );
      const setupStillUnverified = task?.key === "setup-mfa" && session.user?.totpEnabled === false;
      setRecoveryAcknowledgementPending(
        markerPending && (verifiedMfaSessionId === session.id || !setupStillUnverified),
      );
    } finally {
      setCheckedRecoverySessionId(session.id);
    }
  }, [session?.id, session?.user?.totpEnabled, task?.key, verifiedMfaSessionId]);

  useEffect(() => {
    if (
      shouldFetchNextOrganizationPage({
        taskKey: task?.key,
        loaded: organizations.isLoaded,
        hasNextPage: organizations.userMemberships.hasNextPage,
        isFetching: organizations.userMemberships.isFetching,
        isError: organizations.userMemberships.isError,
      })
    ) {
      organizations.userMemberships.fetchNext?.();
    }
  }, [
    organizations.isLoaded,
    organizations.userMemberships.fetchNext,
    organizations.userMemberships.hasNextPage,
    organizations.userMemberships.isError,
    organizations.userMemberships.isFetching,
    task?.key,
  ]);

  async function advance(mfaRecoveryCodesAcknowledged = false) {
    const current = clerk.session ?? session;
    if (!current) throw new Error("Your session could not be loaded. Please try again.");
    const reloaded = await current.reload();
    const markerPending = hasPendingMfaRecoveryAcknowledgement(reloaded.id, (key) =>
      sessionStorage.getItem(key),
    );
    const destination = markerPending
      ? mfaRecoveryDestination(reloaded, redirectTo, mfaRecoveryCodesAcknowledged)
      : sessionTaskDestination(reloaded, redirectTo);
    if (!destination) {
      throw new Error("Account setup is still pending. Please try again.");
    }
    router.replace(destination);
  }

  async function run(action: () => Promise<unknown>) {
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      await action();
      await advance();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Account setup could not be completed.");
    } finally {
      setPending(false);
    }
  }

  async function chooseOrganization(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const organizationId =
      selectedOrganization || organizations.userMemberships.data?.[0]?.organization.id;
    if (!organizationId || !organizations.setActive) {
      setError("Select a workspace to continue.");
      return;
    }
    await run(() => organizations.setActive({ organization: organizationId }));
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session?.user) {
      setError("Your account could not be loaded. Please try again.");
      return;
    }
    if (newPassword !== confirmedPassword) {
      setError("Passwords do not match.");
      return;
    }
    await run(() => session.user.updatePassword({ newPassword }));
  }

  async function createAuthenticator() {
    if (!session?.user) {
      setError("Your account could not be loaded. Please try again.");
      return;
    }
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      const totp = await session.user.createTOTP();
      const secret = totp.secret ?? totp.uri;
      if (!secret) throw new Error("An authenticator key could not be created.");
      setTotpSecret(secret);
      setGeneratedRecoveryCodes(totp.backupCodes ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authenticator setup could not start.");
    } finally {
      setPending(false);
    }
  }

  async function verifyAuthenticator(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session?.user) {
      setError("Your account could not be loaded. Please try again.");
      return;
    }
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      const totp = await verifyTotpWithPendingRecoveryAcknowledgement({
        markPending: () =>
          sessionStorage.setItem(`useagent:mfa-recovery-ack:${session.id}`, "pending"),
        verify: () => session.user.verifyTOTP({ code: totpCode }),
      });
      setVerifiedMfaSessionId(session.id);
      setRecoveryAcknowledgementPending(true);
      const codes = totp.backupCodes?.length
        ? totp.backupCodes
        : generatedRecoveryCodes.length
          ? generatedRecoveryCodes
          : (await session.user.createBackupCode()).codes;
      if (!codes.length)
        throw new Error("Recovery codes could not be generated. Please try again.");
      setRecoveryCodes(codes);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Authenticator verification failed.");
    } finally {
      setPending(false);
    }
  }

  async function retryRecoveryCodes() {
    if (!session?.user || pending) return;
    setError(null);
    setPending(true);
    try {
      const backupCodes = await session.user.createBackupCode();
      if (!backupCodes.codes.length) {
        throw new Error("Recovery codes could not be generated. Please try again.");
      }
      setRecoveryCodes(backupCodes.codes);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Recovery codes could not be generated.");
    } finally {
      setPending(false);
    }
  }

  async function acknowledgeRecoveryCodes() {
    if (!recoveryCodes || pending) return;
    setError(null);
    setPending(true);
    try {
      await advance(true);
      sessionStorage.removeItem(`useagent:mfa-recovery-ack:${session?.id}`);
      setVerifiedMfaSessionId(null);
      setRecoveryAcknowledgementPending(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Account setup could not be completed.");
    } finally {
      setPending(false);
    }
  }

  async function signOut() {
    if (pending) return;
    setError(null);
    setPending(true);
    const marker = session?.id ? `useagent:mfa-recovery-ack:${session.id}` : null;
    try {
      await signOutBeforeClearingRecoveryMarker(
        () => clerk.signOut({ redirectUrl: "/login" }),
        () => {
          if (marker) sessionStorage.removeItem(marker);
        },
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sign-out could not be completed.");
      setPending(false);
    }
  }

  if (!clerk.loaded) {
    return <TaskShell title="Finishing account setup" message="Loading your secure session…" />;
  }

  if (session?.id && checkedRecoverySessionId !== session.id) {
    return <TaskShell title="Finishing account setup" message="Checking your secure session…" />;
  }

  if (recoveryAcknowledgementPending) {
    return (
      <TaskShell
        title="Save your recovery codes"
        message="Store these one-time codes somewhere safe before continuing."
        error={error}
      >
        {recoveryCodes ? (
          <>
            <ul className="mt-6 grid grid-cols-2 gap-2" aria-label="Recovery codes">
              {recoveryCodes.map((code) => (
                <li
                  key={code}
                  className="rounded-xl bg-background-secondary-default px-3 py-2 font-mono text-body-2-medium text-text-primary"
                >
                  {code}
                </li>
              ))}
            </ul>
            <Button
              type="button"
              className="mt-6 h-10 w-full rounded-full"
              disabled={pending}
              onClick={() => void acknowledgeRecoveryCodes()}
            >
              {pending ? "Finishing…" : "I saved these codes"}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            className="mt-6 h-10 w-full rounded-full"
            disabled={pending}
            onClick={() => void retryRecoveryCodes()}
          >
            {pending ? "Generating…" : "Try generating codes again"}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          className="mt-3 w-full rounded-full"
          disabled={pending}
          onClick={signOut}
        >
          Sign out
        </Button>
      </TaskShell>
    );
  }

  if (!session || !task) {
    return (
      <TaskShell
        title="Account setup unavailable"
        message="Your required setup step could not be loaded."
        error={error}
      >
        <TaskActions pending={pending} retry={() => void run(async () => {})} signOut={signOut} />
      </TaskShell>
    );
  }

  if (task.key === "choose-organization") {
    const memberships = organizations.userMemberships.data ?? [];
    const failed = organizations.userMemberships.isError;
    const loading =
      !failed &&
      (!organizations.isLoaded ||
        organizations.userMemberships.isLoading ||
        organizations.userMemberships.isFetching ||
        organizations.userMemberships.hasNextPage);

    return (
      <TaskShell
        title="Choose your workspace"
        message="Select the workspace you want to open."
        error={
          error ??
          (organizations.userMemberships.isError ? "Workspaces could not be loaded." : null)
        }
      >
        {loading ? (
          <p className="mt-6 text-body-2-regular text-text-secondary">Loading workspaces…</p>
        ) : failed ? (
          <Button
            type="button"
            className="mt-6 h-10 w-full rounded-full"
            onClick={() => void organizations.userMemberships.revalidate?.()}
          >
            Try again
          </Button>
        ) : memberships.length > 0 ? (
          <form className="mt-8 flex flex-col gap-4" onSubmit={chooseOrganization}>
            <div className="flex flex-col gap-1.5">
              <p className="text-body-2-medium text-text-primary">Workspace</p>
              <Select
                aria-label="Workspace"
                placeholder="Select a workspace"
                selectedKey={selectedOrganization || memberships[0]?.organization.id}
                onSelectionChange={(key) => setSelectedOrganization(String(key))}
              >
                {memberships.map((membership) => (
                  <SelectItem key={membership.id} id={membership.organization.id}>
                    {membership.organization.name}
                  </SelectItem>
                ))}
              </Select>
            </div>
            <Button type="submit" className="mt-2 h-10 w-full rounded-full" disabled={pending}>
              {pending ? "Opening…" : "Continue"}
            </Button>
          </form>
        ) : (
          <>
            <p role="alert" className="mt-6 text-body-2-regular text-text-error-primary">
              Your account does not belong to a workspace. Ask an administrator for an invitation.
            </p>
            <Button
              type="button"
              className="mt-4 h-10 w-full rounded-full"
              onClick={() => void organizations.userMemberships.revalidate?.()}
            >
              Try again
            </Button>
          </>
        )}
        <Button
          type="button"
          variant="ghost"
          className="mt-3 w-full rounded-full"
          disabled={pending}
          onClick={signOut}
        >
          Sign out
        </Button>
      </TaskShell>
    );
  }

  if (task.key === "reset-password") {
    return (
      <TaskShell
        title="Set a new password"
        message="Update your password before continuing to useAgent."
        error={error}
      >
        <form className="mt-8 flex flex-col gap-4" onSubmit={resetPassword}>
          <Input
            name="newPassword"
            type="password"
            label="New password"
            autoComplete="new-password"
            value={newPassword}
            onChange={setNewPassword}
            isRequired
          />
          <Input
            name="confirmedPassword"
            type="password"
            label="Confirm new password"
            autoComplete="new-password"
            value={confirmedPassword}
            onChange={setConfirmedPassword}
            isRequired
          />
          <Button type="submit" className="mt-2 h-10 w-full rounded-full" disabled={pending}>
            {pending ? "Updating…" : "Update password"}
          </Button>
        </form>
        <Button
          type="button"
          variant="ghost"
          className="mt-3 w-full rounded-full"
          disabled={pending}
          onClick={signOut}
        >
          Sign out
        </Button>
      </TaskShell>
    );
  }

  if (task.key === "setup-mfa") {
    return (
      <TaskShell
        title="Set up an authenticator"
        message="Add useAgent to your authenticator app, then enter its six-digit code."
        error={error}
      >
        {totpSecret ? (
          <form className="mt-8 flex flex-col gap-4" onSubmit={verifyAuthenticator}>
            <Input
              label="Authenticator key"
              value={totpSecret}
              isReadOnly
              hint="Enter this key manually in your authenticator app."
            />
            <Input
              name="totpCode"
              label="Verification code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={totpCode}
              onChange={setTotpCode}
              isRequired
            />
            <Button type="submit" className="mt-2 h-10 w-full rounded-full" disabled={pending}>
              {pending ? "Verifying…" : "Verify authenticator"}
            </Button>
          </form>
        ) : (
          <Button
            type="button"
            className="mt-8 h-10 w-full rounded-full"
            disabled={pending}
            onClick={() => void createAuthenticator()}
          >
            {pending ? "Preparing…" : "Set up authenticator"}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          className="mt-3 w-full rounded-full"
          disabled={pending}
          onClick={signOut}
        >
          Sign out
        </Button>
      </TaskShell>
    );
  }

  return (
    <TaskShell
      title="Account setup required"
      message="This required account setup step is not supported yet."
      error={error}
    >
      <TaskActions pending={pending} retry={() => void run(async () => {})} signOut={signOut} />
    </TaskShell>
  );
}

function TaskShell({
  title,
  message,
  error,
  children,
}: {
  title: string;
  message: string;
  error?: string | null;
  children?: React.ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-[360px]">
      <h1 className="text-title-2-medium text-text-primary">{title}</h1>
      <p className="mt-1.5 text-body-regular text-text-secondary">{message}</p>
      {children}
      {error && (
        <p role="alert" className="mt-4 text-body-2-regular text-text-error-primary">
          {error}
        </p>
      )}
    </div>
  );
}

function TaskActions({
  pending,
  retry,
  signOut,
}: {
  pending: boolean;
  retry: () => void;
  signOut: () => void;
}) {
  return (
    <div className="mt-6 flex flex-col gap-3">
      <Button className="h-10 w-full rounded-full" disabled={pending} onClick={retry}>
        {pending ? "Checking…" : "Try again"}
      </Button>
      <Button variant="ghost" className="w-full rounded-full" disabled={pending} onClick={signOut}>
        Sign out
      </Button>
    </div>
  );
}
