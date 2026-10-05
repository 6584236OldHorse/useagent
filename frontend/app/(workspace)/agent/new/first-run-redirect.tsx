"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { listWorkspaces, useSession } from "@/lib/auth";
import { watchLanding } from "@/lib/first-run";

/** Rendered by the composer: sends a person who lands in a workspace nobody
 *  has set up yet to the first-run page, unless the composer already holds a
 *  draft when the check answers (the account menu still offers the page) or
 *  they chose to continue before in this browser. */
export function FirstRunRedirect({ hasDraft }: { hasDraft: () => boolean }) {
  const router = useRouter();
  const { session, loading } = useSession();

  useEffect(() => {
    if (loading || !session) return;
    return watchLanding({
      userId: session.user.id,
      listWorkspaces,
      hasDraft,
      open: () => router.replace("/welcome"),
    });
  }, [hasDraft, loading, router, session]);

  return null;
}
