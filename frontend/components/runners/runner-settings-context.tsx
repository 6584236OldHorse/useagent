"use client";

import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useSession } from "@/lib/auth";
import {
  canManageRunnerPolicy,
  fetchRunnerPolicy,
  fetchRunners,
  revokeRunner,
  updateRunnerPolicy,
} from "./runner-api";
import type { Runner, RunnerPolicy } from "./runner-data";

function useRunnerSettingsState() {
  const { loading: sessionLoading, session } = useSession();
  const [runners, setRunners] = useState<Runner[]>([]);
  const [policy, setPolicy] = useState<RunnerPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canManagePolicy, setCanManagePolicy] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    const [runnersResult, policyResult] = await Promise.allSettled([
      fetchRunners(),
      fetchRunnerPolicy(),
    ]);
    if (runnersResult.status === "fulfilled") setRunners(runnersResult.value);
    if (policyResult.status === "fulfilled") setPolicy(policyResult.value);
    setError(
      runnersResult.status === "rejected" || policyResult.status === "rejected"
        ? "Could not refresh local runner settings."
        : null,
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (sessionLoading) return;
    if (!session) {
      setCanManagePolicy(false);
      return;
    }
    let cancelled = false;
    void canManageRunnerPolicy(session.user.id)
      .then((allowed) => {
        if (!cancelled) setCanManagePolicy(allowed);
      })
      .catch(() => {
        if (!cancelled) setCanManagePolicy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [session, sessionLoading]);

  const revoke = useCallback(async (id: string) => {
    await revokeRunner(id);
    setRunners((current) => current.filter((runner) => runner.id !== id));
  }, []);

  const savePolicy = useCallback(async (patch: Partial<RunnerPolicy>) => {
    try {
      const saved = await updateRunnerPolicy(patch);
      setPolicy(saved);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name === "ForbiddenError"
          ? "Only organization admins can change local runner policy."
          : "Could not save local runner policy.",
      );
      throw cause;
    }
  }, []);

  return { canManagePolicy, error, load, loading, policy, revoke, runners, savePolicy };
}

type RunnerSettingsState = ReturnType<typeof useRunnerSettingsState>;
const RunnerSettingsContext = createContext<RunnerSettingsState | null>(null);

export function RunnerSettingsProvider({ children }: { readonly children: ReactNode }) {
  return createElement(RunnerSettingsContext.Provider, {
    value: useRunnerSettingsState(),
    children,
  });
}

export function useRunnerSettings(): RunnerSettingsState {
  const value = useContext(RunnerSettingsContext);
  if (!value) throw new Error("useRunnerSettings requires RunnerSettingsProvider");
  return value;
}
