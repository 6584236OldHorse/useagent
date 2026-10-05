"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthScreen } from "@/components/auth/auth-screen";
import { Button } from "@/components/base/buttons/button";
import { invalidateSession, useSession } from "@/lib/auth";
import { backendFetch } from "@/lib/backend-fetch";
import { invitationProblem } from "./invitation-problem";

/**
 * The page an invitation link opens. Signed out: send the person to sign in
 * and come straight back. Signed in: show who invited them where, one button
 * to join, then land in that workspace.
 */

export interface InvitationView {
  readonly organizationName: string;
  /** Null once the inviter has left the organisation; the invitation still stands. */
  readonly inviterEmail: string | null;
  readonly email: string;
  readonly role: string;
}

async function fetchInvitation(id: string): Promise<{ view: InvitationView } | { problem: string }> {
  try {
    const res = await backendFetch(`/api/auth/invitation-preview?id=${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      return { problem: invitationProblem(res.status, body?.message ?? null) };
    }
    return { view: (await res.json()) as InvitationView };
  } catch {
    // Transport failures and a body that never arrives look the same to the person.
    return { problem: invitationProblem(0, null) };
  }
}

async function accept(id: string): Promise<string | null> {
  try {
    const res = await backendFetch("/api/auth/organization/accept-invitation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invitationId: id }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    return invitationProblem(res.status, body?.message ?? null);
  } catch {
    return invitationProblem(0, null);
  }
}

export function AcceptInvitation({ id }: { id: string }) {
  const router = useRouter();
  const { session, loading } = useSession();
  const [state, setState] = useState<{ view: InvitationView } | { problem: string } | null>(null);
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (loading) return;
    if (!session) {
      router.replace(`/login?redirect_url=${encodeURIComponent(`/accept-invitation/${id}`)}`);
      return;
    }
    let cancelled = false;
    setState(null);
    fetchInvitation(id).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt, id, loading, router, session]);

  const join = async () => {
    setJoining(true);
    const problem = await accept(id);
    if (problem) {
      setState({ problem });
      setJoining(false);
      return;
    }
    invalidateSession();
    setJoined(true);
    router.replace("/");
  };

  return (
    <AuthScreen>
      <div className="flex flex-col gap-4">
        {state === null ? (
          <p className="text-body-2-regular text-text-secondary">Checking your invitation...</p>
        ) : "problem" in state ? (
          <>
            <p role="alert" className="text-body-2-regular text-text-error-primary">{state.problem}</p>
            <div className="flex gap-2">
              <Button variant="secondary" size="small" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
              <Button variant="ghost" size="small" onClick={() => router.replace("/")}>
                Go to useAgent
              </Button>
            </div>
          </>
        ) : (
          <>
            <h1 className="text-title-3-medium text-text-primary">Join {state.view.organizationName}</h1>
            <p className="text-body-2-regular text-text-secondary">
              {state.view.inviterEmail ?? "A teammate"} invited {state.view.email} as{" "}
              {state.view.role === "admin" ? "an admin" : state.view.role === "owner" ? "an owner" : "a member"}.
            </p>
            <Button variant="primary" size="medium" disabled={joining || joined} onClick={() => void join()}>
              {joined ? "Joined" : joining ? "Joining..." : "Join workspace"}
            </Button>
          </>
        )}
      </div>
    </AuthScreen>
  );
}
