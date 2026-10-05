"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** The thread-rail destinations a user hops between all day: warmed in full,
 * one server render each at idle, so their own chunks are cached before the
 * first hop. */
export const PRIMARY_ROUTES = ["/dashboard", "/agent/new", "/agent/runs", "/bots"] as const;

/** The Customize pages: warmed to their loading boundary (layout, skeleton and
 * shared chunks); their own page chunk arrives on the first visit and stays
 * cached after that. */
export const SECONDARY_ROUTES = [
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

export const APP_ROUTES = [...PRIMARY_ROUTES, ...SECONDARY_ROUTES] as const;

type PrefetchOptions = NonNullable<Parameters<ReturnType<typeof useRouter>["prefetch"]>[1]>;
// Next does not export its prefetch kind enum from next/navigation; the runtime
// values are the strings "auto" (the default) and "full".
const FULL = { kind: "full" } as unknown as PrefetchOptions;

/**
 * Warm every app route once the first page is idle, so an in-app hop never waits
 * on a chunk download. Primary routes are prefetched in full (their page payload
 * and chunks, one backend-backed render each, once per app load); the rest stop
 * at their loading boundary and never run a page's backend loaders. Chunks are
 * content-hashed and stay in the browser cache across hops and reloads.
 */
export function RoutePrefetch() {
  const router = useRouter();
  useEffect(() => {
    const schedule = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
    const cancel = window.cancelIdleCallback ?? window.clearTimeout;
    const handle = schedule(() => {
      for (const href of PRIMARY_ROUTES) router.prefetch(href, FULL);
      for (const href of SECONDARY_ROUTES) router.prefetch(href);
    });
    return () => cancel(handle);
  }, [router]);
  return null;
}
