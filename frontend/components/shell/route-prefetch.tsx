"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { type Connection, warmRouteChunks } from "@/lib/warm-route-chunks";

/** Every top-level page a signed-in user can reach from the rails, except
 * /bots: its layout seeds the roster on the server above the loading boundary,
 * so a prefetch would cache that roster for the static window and the panel does
 * not refresh its seed on first mount. Bots loads fresh on the hop. */
export const APP_ROUTES = [
  "/dashboard",
  "/agent/new",
  "/agent/runs",
  "/settings",
  "/skills",
  "/playbooks",
  "/agent/automations",
  "/knowledge",
  "/memory",
  "/learnings",
  "/wiki",
  "/review",
  "/apps",
  "/agent/artifacts",
  "/agent/plugins",
  "/tasks",
  "/secrets",
] as const;

/**
 * Warm every app route once the first page is idle, so an in-app hop never waits
 * on the shell: the router prefetch pulls each route's layouts, its loading
 * boundary and the chunks they reference, and a static page in full. A dynamic
 * page stops at its loading boundary, so no page data is cached and no page
 * loader runs; its own chunk arrives on the first visit and stays in the browser
 * cache after that (chunks are content-hashed). Full prefetch was tried and
 * dropped: it caches a dynamic page's data for the static window, and pages that
 * seed state from that payload (dashboard runs, the new-thread catalog) have no
 * refresh path for a mutation made elsewhere.
 */
export function RoutePrefetch() {
  const router = useRouter();
  useEffect(() => {
    const schedule = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const handle = schedule(() => {
      for (const href of APP_ROUTES) router.prefetch(href);
      // Then the code itself: every signed-in route's chunks, so a first hop
      // downloads nothing (a dynamic page's prefetch stops at its loading boundary).
      void warmRouteChunks({ connection: (navigator as Navigator & { connection?: Connection }).connection }).catch(() => undefined);
    });
    return () => cancel(handle);
  }, [router]);
  return null;
}
