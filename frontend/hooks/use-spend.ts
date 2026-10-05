"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { backendFetch } from "@/lib/backend-fetch";
import { STREAM_OPEN_GRACE_MS } from "@/lib/org-changes";
import { parseSpend, scheduleSpendReads, spendLoader, type SpendSnapshot } from "@/lib/spend";
import { useOrgChanges } from "./use-org-changes";

async function fetchSpend(signal?: AbortSignal): Promise<SpendSnapshot | null> {
  const res = await backendFetch("/api/spend", { signal, cache: "no-store" });
  return res.ok ? parseSpend(await res.json()) : null;
}

/**
 * The member's settled spend against their allowance: one read per page, taken
 * once the org stream is open (or after the grace when the stream is slow), and
 * again whenever a run in the org settles (that is what moves the figure) or the
 * stream reconnects. Only the newest request may report, so an older response
 * never undoes a newer figure; a transient failure keeps the last good snapshot;
 * null until the first read.
 */
export function useSpend(): SpendSnapshot | null {
  const [spend, setSpend] = useState<SpendSnapshot | null>(null);
  const load = useMemo(() => spendLoader(fetchSpend, setSpend), []);
  const reads = useRef<ReturnType<typeof scheduleSpendReads> | null>(null);

  useOrgChanges(
    (change) => {
      if (change.type === "run" && (change.action === "settled" || change.action === "cancelled")) void load();
    },
    () => reads.current?.streamOpened(),
  );

  useEffect(() => {
    reads.current = scheduleSpendReads(() => void load(), STREAM_OPEN_GRACE_MS);
    return () => {
      reads.current?.stop();
      reads.current = null;
    };
  }, [load]);

  return spend;
}
