"use client";

import { RiComputerLine } from "@remixicon/react";
import type { RunLocation as RunLocationChoice } from "@useagent/agent-client/wire";
import { useEffect, useState } from "react";
import { fetchRunners, fetchSandboxProviderName, type SandboxProviderName } from "./runner-api";
import { localRunnerId, PROVIDER_NAMES, type Runner, runnerLocationLabel } from "./runner-data";

export type LocatedRun = {
  readonly sandbox_id: string | null;
  readonly sandbox_provider?: unknown;
  /** Where the thread asked to run; names the place before any sandbox exists. */
  readonly run_location?: RunLocationChoice | null;
};

/** Where a run executes, named: the runner's machine for a local sandbox, the
 *  provider for a cloud one; null while nothing is recorded. Shared by the
 *  Details rail and the composer's status tab. */
export function useRunLocationLabel(run: LocatedRun): string | null {
  const [runners, setRunners] = useState<Runner[]>([]);
  const [deployment, setDeployment] = useState<SandboxProviderName | null>(null);
  const sandboxId = run.sandbox_id;
  const sandboxProvider = run.sandbox_provider;
  const runnerId = localRunnerId(sandboxId);
  useEffect(() => {
    if (!runnerId) return;
    let cancelled = false;
    void fetchRunners()
      .then((value) => {
        if (!cancelled) setRunners(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [runnerId]);
  // A cloud run is named by what the deployment's provider points at (E2B or
  // Cube for the E2B-protocol plugin), which only the config knows.
  const cloud = !runnerId && typeof sandboxProvider === "string";
  useEffect(() => {
    if (!cloud) return;
    let cancelled = false;
    void fetchSandboxProviderName().then((value) => {
      if (!cancelled && value) setDeployment(value);
    });
    return () => {
      cancelled = true;
    };
  }, [cloud]);
  if (!sandboxId && !sandboxProvider && !run.run_location) return null;
  const names =
    deployment && deployment.provider === sandboxProvider
      ? { ...PROVIDER_NAMES, [deployment.provider]: deployment.label }
      : PROVIDER_NAMES;
  return runnerLocationLabel(sandboxId, sandboxProvider, runners, names, run.run_location);
}

export function RunLocation({ run }: { readonly run: LocatedRun }) {
  const label = useRunLocationLabel(run);
  if (!label) return null;
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 text-caption-1-regular text-text-tertiary"
      title={`Runs on ${label}`}
    >
      <RiComputerLine aria-hidden className="size-3.5 shrink-0" />
      <span className="max-w-36 truncate">{label}</span>
    </span>
  );
}
