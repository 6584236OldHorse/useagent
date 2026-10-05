"use client";

import { RiCheckboxCircleLine, RiCloseCircleLine } from "@remixicon/react";
import { runnerLoginAvailable } from "./runner-data";
import { useRunnerSettings } from "./runner-settings-context";

const ENGINE_LOGINS = [
  { engine: "Codex", login: "codex" },
  { engine: "Claude", login: "claude" },
] as const;

export function LocalLoginAvailability() {
  const { loading, policy, runners } = useRunnerSettings();
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
      {ENGINE_LOGINS.map(({ engine, login }) => {
        const available = runnerLoginAvailable(login, policy, runners);
        const Icon = available ? RiCheckboxCircleLine : RiCloseCircleLine;
        return (
          <div
            key={login}
            className="flex items-center justify-between gap-3 border-b border-separator-border py-3 last:border-b-0"
          >
            <p className="text-body-2-medium text-text-primary">{engine}</p>
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
