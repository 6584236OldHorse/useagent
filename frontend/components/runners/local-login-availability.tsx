"use client";

import { RiCheckboxCircleLine, RiCloseCircleLine } from "@remixicon/react";
import { useMemo } from "react";
import type { EngineId } from "@/components/chat/types";
import { runnerRunsUserWork, runnerLoginAvailable } from "./runner-data";
import { useOptionalRunnerSettings, useRunnerSettings } from "./runner-settings-context";

const ENGINE_LOGINS = [
  { engine: "codex", label: "Codex", login: "codex" },
  { engine: "claude", label: "Claude", login: "claude" },
] as const;

export function useLocalLoginOffers(): readonly EngineId[] {
  const settings = useOptionalRunnerSettings();
  const policy = settings?.policy ?? null;
  const runners = settings?.runners ?? [];
  const userId = settings?.userId ?? null;
  const runnerEnabled = settings?.runnerEnabled ?? false;
  return useMemo(
    () =>
      ENGINE_LOGINS.filter(({ login }) =>
        runnerLoginAvailable(login, policy, runners, userId, runnerEnabled),
      ).map(({ engine }) => engine),
    [policy, runnerEnabled, runners, userId],
  );
}

export function LocalLoginAvailability() {
  const { loading, policy, runnerEnabled, runners, userId } = useRunnerSettings();
  if (loading) return null;
  return (
    <div className="rounded-xl border border-border-button-default bg-background-secondary-default px-4">
      <div className="border-b border-separator-border py-3">
        <p className="text-body-2-medium text-text-primary">Logins from your machines</p>
        <p className="text-caption-1-regular text-text-tertiary">
          Availability is reported by each runner. Per-engine opt-in is not available in this
          version.
        </p>
      </div>
      {ENGINE_LOGINS.map(({ label, login }) => {
        const available = runnerLoginAvailable(login, policy, runners, userId, runnerEnabled);
        const Icon = available ? RiCheckboxCircleLine : RiCloseCircleLine;
        return (
          <div
            key={login}
            className="flex items-center justify-between gap-3 border-b border-separator-border py-3 last:border-b-0"
          >
            <p className="text-body-2-medium text-text-primary">{label}</p>
            <span className="flex items-center gap-1.5 text-caption-1-regular text-text-secondary">
              <Icon
                aria-hidden
                className={
                  available
                    ? "size-4 text-status-lime-text"
                    : "size-4 text-foreground-icon-tertiary"
                }
              />
              {available ? "Login available" : "No login available"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** True while this user's own machine will run new threads. */
export function useMachineRunsWork(): boolean {
  const { policy, runnerEnabled, runners, userId } = useRunnerSettings();
  return useMemo(() => runnerRunsUserWork(policy, runners, userId, runnerEnabled), [policy, runnerEnabled, runners, userId]);
}
