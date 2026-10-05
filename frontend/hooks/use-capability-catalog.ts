"use client";

import { useEffect, useState } from "react";
import { cachedRequest } from "@/lib/cached-request";
import { type CapabilityCatalog, fetchCapabilityCatalog } from "@/lib/capability-catalog";

export const CAPABILITY_CATALOG_RETRY_DELAYS_MS = [
  1_000, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000,
] as const;

/** How long a page reuses one catalog across the components that read it. */
export const CAPABILITY_CATALOG_TTL_MS = 30_000;

/**
 * One catalog request per page: every consumer that mounts within the ttl
 * reads the same response. A failed load (null) is never kept, and a refresh
 * retry asks for a fresh catalog so it can observe the native refresh settling.
 */
export function createCapabilityCatalogLoader(
  fetchCatalog: () => Promise<CapabilityCatalog | null>,
  options: { readonly ttlMs?: number; readonly isShared?: () => boolean } = {},
): (fresh?: boolean) => Promise<CapabilityCatalog | null> {
  const request = cachedRequest(fetchCatalog, { ttlMs: CAPABILITY_CATALOG_TTL_MS, ...options });
  return async (fresh = false) => {
    const catalog = await request.get(fresh);
    if (catalog === null) request.invalidate();
    return catalog;
  };
}

export const loadCapabilityCatalog = createCapabilityCatalogLoader(() => fetchCapabilityCatalog());

type CapabilityCatalogTimer = ReturnType<typeof setTimeout> | number;

interface CapabilityCatalogPollDependencies {
  readonly fetchCatalog?: (fresh: boolean) => Promise<CapabilityCatalog | null>;
  readonly setTimer?: (callback: () => void, delayMs: number) => CapabilityCatalogTimer;
  readonly clearTimer?: (timer: CapabilityCatalogTimer) => void;
}

export function pollCapabilityCatalog(
  publish: (state: { catalog: CapabilityCatalog | null; loaded: boolean }) => void,
  dependencies: CapabilityCatalogPollDependencies = {},
): () => void {
  const fetchCatalog = dependencies.fetchCatalog ?? loadCapabilityCatalog;
  const setTimer = dependencies.setTimer ?? setTimeout;
  const clearTimer = dependencies.clearTimer ?? clearTimeout;
  let cancelled = false;
  let timer: CapabilityCatalogTimer | undefined;

  const load = async (attempt: number) => {
    const catalog = await fetchCatalog(attempt > 0);
    if (cancelled) return;
    publish({ catalog, loaded: true });
    const codexCatalog = catalog?.engines.find((engine) => engine.id === "codex")?.modelCatalog;
    const delay = CAPABILITY_CATALOG_RETRY_DELAYS_MS[attempt];
    if (codexCatalog?.stale && delay !== undefined) {
      timer = setTimer(() => {
        timer = undefined;
        void load(attempt + 1);
      }, delay);
    }
  };

  void load(0);
  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimer(timer);
  };
}

export function useCapabilityCatalog(): {
  catalog: CapabilityCatalog | null;
  loaded: boolean;
} {
  const [state, setState] = useState<{ catalog: CapabilityCatalog | null; loaded: boolean }>({
    catalog: null,
    loaded: false,
  });
  useEffect(() => {
    return pollCapabilityCatalog(setState);
  }, []);
  return state;
}
