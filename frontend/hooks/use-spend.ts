"use client";

import { useCallback, useEffect, useState } from "react";
import { backendFetch } from "@/lib/backend-fetch";
import { parseSpend, type SpendSnapshot } from "@/lib/spend";
import { useOrgChanges } from "./use-org-changes";

/**
 * The member's settled spend against their allowance, fetched on mount and
 * again on every org run change (a settling turn is what moves the figure).
 * A transient failure keeps the last good snapshot; null until the first read.
 */
export function useSpend(): SpendSnapshot | null {
  const [spend, setSpend] = useState<SpendSnapshot | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await backendFetch("/api/spend", { signal, cache: "no-store" });
      if (!res.ok) return;
      const parsed = parseSpend(await res.json());
      if (parsed) setSpend(parsed);
    } catch {
      // Keep the last good figure.
    }
  }, []);

  useOrgChanges((change) => {
    if (change.type === "run") void load();
  });

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  return spend;
}
