"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { listWorkspaces, useSession } from "@/lib/auth";
import { firstRunApplies, firstRunSkipped } from "@/lib/first-run";

/** Sends a person who lands in a workspace nobody has set up yet to the
 *  first-run page; once they choose to continue, this browser lets them by. */
export function FirstRunRedirect() {
  const router = useRouter();
  const { session, loading } = useSession();

  useEffect(() => {
    if (loading || !session || firstRunSkipped(session.user.id)) return;
    let cancelled = false;
    listWorkspaces()
      .then((workspaces) => {
        if (!cancelled && firstRunApplies(workspaces.find((workspace) => workspace.active))) {
          router.replace("/welcome");
        }
      })
      .catch(() => undefined); // the landing page stands whatever the answer
    return () => {
      cancelled = true;
    };
  }, [loading, router, session]);

  return null;
}
