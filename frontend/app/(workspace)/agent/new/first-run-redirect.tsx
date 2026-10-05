"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { listWorkspaces, useSession } from "@/lib/auth";
import { watchLanding } from "@/lib/first-run";

/** Sends a person who lands in a workspace nobody has set up yet to the
 *  first-run page, unless they have started typing before the check answers
 *  (a draft is never unmounted from under them; the account menu still offers
 *  the page) or chose to continue before in this browser. */
export function FirstRunRedirect() {
  const router = useRouter();
  const { session, loading } = useSession();

  useEffect(() => {
    if (loading || !session) return;
    return watchLanding({
      userId: session.user.id,
      listWorkspaces,
      onInput: (handler) => {
        document.addEventListener("input", handler, true);
        return () => document.removeEventListener("input", handler, true);
      },
      open: () => router.replace("/welcome"),
    });
  }, [loading, router, session]);

  return null;
}
