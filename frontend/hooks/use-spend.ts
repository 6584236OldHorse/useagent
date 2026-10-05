"use client";

import { useEffect, useMemo, useState } from "react";
import { backendFetch } from "@/lib/backend-fetch";
import { parseSpend, spendLoader, type SpendSnapshot } from "@/lib/spend";
import { useOrgChanges } from "./use-org-changes";

async function fetchSpend(signal?: AbortSignal): Promise<SpendSnapshot | null> {
  const res = await backendFetch("/api/spend", { signal, cache: "no-store" });
  return res.ok ? parseSpend(await res.json()) : null;
}

/**
 * The member's settled spend against their allowance, fetched on mount and
 * again whenever a run in the org settles (that is what moves the figure).
 * Only the newest request may report, so an older response never undoes a
 * newer figure; a transient failure keeps the last good snapshot; null until
 * the first read.
 */
export function useSpend(): SpendSnapshot | null {
  const [spend, setSpend] = useState<SpendSnapshot | null>(null);
  const load = useMemo(() => spendLoader(fetchSpend, setSpend), []);

  useOrgChanges(
    (change) => {
      if (change.type === "run" && (change.action === "settled" || change.action === "cancelled")) void load();
    },
    // A settlement missed while the org stream was down is caught up on reconnect.
    () => void load(),
  );

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  return spend;
}
