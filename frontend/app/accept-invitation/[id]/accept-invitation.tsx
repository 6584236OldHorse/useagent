"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthScreen } from "@/components/auth/auth-screen";
import { Button } from "@/components/base/buttons/button";
import { invalidateSession, useSession } from "@/lib/auth";
import { backendFetch } from "@/lib/backend-fetch";

/**
 * The page an invitation link opens. Signed out: send the person to sign in
 * and come straight back. Signed in: show who invited them where, one button
 * to join, then land in that workspace.
 */

export interface InvitationView {
  readonly organizationName: string;
  readonly inviterEmail: string;
  readonly email: string;
  readonly role: string;
}

/** What to tell the person when the server refuses the invitation. */
export function invitationProblem(status: number, message: string | null): string {
  const text = (message ?? "").toLowerCase();
  if (text.includes("not the recipient")) return "This invitation was sent to a different email address. Sign in with the address that received it.";
  if (text.includes("expired") || text.includes("not found") || status === 404) return "This invitation has expired or was cancelled. Ask for a new one.";
  if (text.includes("already a member")) return "You are already a member of this workspace.";
  if (status === 401) return "Sign in to accept this invitation.";
  return message || "This invitation cannot be accepted right now.";
}

async function fetchInvitation(id: string): Promise<{ view: InvitationView } | { problem: string }> {
  const res = await backendFetch(`/api/auth/organization/get-invitation?id=${encodeURIComponent(id)}`, { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    return { problem: invitationProblem(res.status, body?.message ?? null) };
  }
  const body = (await res.json()) as InvitationView;
  return { view: body };
}

async function accept(id: string): Promise<string | null> {
  const res = await backendFetch("/api/auth/organization/accept-invitation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invitationId: id }),
  });
  if (res.ok) return null;
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  return invitationProblem(res.status, body?.message ?? null);
}

export function AcceptInvitation({ id }: { id: string }) {
  const router = useRouter();
  const { session, loading } = useSession();
  const [state, setState] = useState<{ view: InvitationView } | { problem: string } | null>(null);
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!session) {
      router.replace(`/login?redirect_url=${encodeURIComponent(`/accept-invitation/${id}`)}`);
      return;
    }
    let cancelled = false;
    fetchInvitation(id).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [id, loading, router, session]);

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
            <Button variant="secondary" size="small" onClick={() => router.replace("/")}>
              Go to useAgent
            </Button>
          </>
        ) : (
          <>
            <h1 className="text-title-3-medium text-text-primary">Join {state.view.organizationName}</h1>
            <p className="text-body-2-regular text-text-secondary">
              {state.view.inviterEmail} invited {state.view.email} as {state.view.role === "admin" ? "an admin" : state.view.role === "owner" ? "an owner" : "a member"}.
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
