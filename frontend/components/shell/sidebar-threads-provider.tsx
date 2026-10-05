"use client";

import type { ThreadRelationship } from "@useagent/agent-client";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { fetchSidebarRuns } from "@/app/(workspace)/agent/runs/runs-data";
import { useOrgChanges } from "@/hooks/use-org-changes";
import type { OrgChange } from "@/lib/org-changes";
import { fetchThreadRelationshipIndex } from "@/lib/thread-relationships-data";
import type { SidebarRun } from "./working-project-status";

const SidebarThreadsContext = createContext<readonly SidebarRun[] | null>(null);
const SidebarThreadRelationshipsContext = createContext<readonly ThreadRelationship[] | null>(null);

/** How long a mount waits for the invalidation stream to open before it takes
 *  its snapshot anyway (a blocked or slow stream must not leave the shell empty). */
export const STREAM_OPEN_GRACE_MS = 1_500;

export function refreshesSidebarThreads(change: OrgChange): boolean {
  return (
    change.type === "run" ||
    change.type === "thread_relationship" ||
    change.type === "execution_graph" ||
    (change.type === "automation" && change.action === "fired")
  );
}

/** Owns the shell's single thread snapshot and refreshes it from the shared SSE. */
export function SidebarThreadsProvider({ children }: { children: ReactNode }) {
  const [runs, setRuns] = useState<SidebarRun[]>([]);
  const [relationships, setRelationships] = useState<readonly ThreadRelationship[]>([]);

  const load = useCallback(async (revalidate = false) => {
    try {
      const [nextRuns, nextRelationships] = await Promise.allSettled([
        fetchSidebarRuns({ revalidate }),
        fetchThreadRelationshipIndex({ revalidate }),
      ]);
      if (nextRuns.status === "fulfilled") setRuns(nextRuns.value);
      if (nextRelationships.status === "fulfilled") {
        setRelationships(nextRelationships.value.relationships);
      }
    } catch {
      // Keep the last good shell snapshot on transient auth/network failures.
    }
  }, []);

  // One snapshot per mount, taken once the invalidation stream is open, so no
  // change can land unseen between the snapshot's read and the stream; a
  // reconnect takes one again. If the stream is slow or blocked, the grace
  // timer takes the snapshot anyway and the open that follows revalidates it.
  const grace = useRef<ReturnType<typeof setTimeout> | null>(null);
  useOrgChanges(
    (change) => {
      if (refreshesSidebarThreads(change)) void load(true);
    },
    () => {
      if (grace.current !== null) {
        clearTimeout(grace.current);
        grace.current = null;
      }
      void load(true);
    },
  );

  useEffect(() => {
    grace.current = setTimeout(() => {
      grace.current = null;
      void load();
    }, STREAM_OPEN_GRACE_MS);
    return () => {
      if (grace.current !== null) clearTimeout(grace.current);
    };
  }, [load]);

  return (
    <SidebarThreadsContext value={runs}>
      <SidebarThreadRelationshipsContext value={relationships}>
        {children}
      </SidebarThreadRelationshipsContext>
    </SidebarThreadsContext>
  );
}

export function useSidebarThreadRelationships(): readonly ThreadRelationship[] {
  const relationships = useContext(SidebarThreadRelationshipsContext);
  if (relationships === null) {
    throw new Error("useSidebarThreadRelationships must be used inside SidebarThreadsProvider");
  }
  return relationships;
}

export function useSidebarThreads(): readonly SidebarRun[] {
  const runs = useContext(SidebarThreadsContext);
  if (runs === null)
    throw new Error("useSidebarThreads must be used inside SidebarThreadsProvider");
  return runs;
}
