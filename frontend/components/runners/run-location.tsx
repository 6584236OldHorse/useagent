"use client";

import { RiCloudLine, RiComputerLine } from "@remixicon/react";
import type { RunLocation as RunLocationChoice } from "@useagent/agent-client/wire";
import { useEffect, useState } from "react";
import { fetchRunners, fetchSandboxProviderName, type SandboxProviderName } from "./runner-api";
import {
  localRunnerId,
  PROVIDER_NAMES,
  type Runner,
  runnerLocationLabel,
  runOnMachine,
  sandboxVendorLabel,
} from "./runner-data";

export type LocatedRun = {
  readonly sandbox_id: string | null;
  readonly sandbox_provider?: unknown;
  /** Where the thread asked to run; names the place before any sandbox exists. */
  readonly run_location?: RunLocationChoice | null;
};

export type RunLocationLabel = {
  /** The two words the tab and rail print: the machine's name or "Cloud". */
  readonly label: string;
  /** The vendor, for the title only, when a hosted sandbox recorded one. */
  readonly title: string;
  /** The run location menu's glyph for the place: a cloud, or a computer for the machine. */
  readonly icon: typeof RiCloudLine;
};

/** Where a run executes: the runner's machine for a local sandbox, "Cloud" for
 *  a hosted one, with the vendor on the title; null while nothing is recorded.
 *  Shared by the Details rail and the composer's status tab. */
export function useRunLocationLabel(run: LocatedRun): RunLocationLabel | null {
  const [runners, setRunners] = useState<Runner[]>([]);
  const [deployment, setDeployment] = useState<SandboxProviderName | null>(null);
  const sandboxId = run.sandbox_id;
  const sandboxProvider = run.sandbox_provider;
  const runnerId = localRunnerId(sandboxId);
  const machine = runOnMachine(sandboxId, sandboxProvider, run.run_location);
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
  // A cloud run's vendor is what the deployment's provider points at (E2B or
  // Cube for the E2B-protocol plugin), which only the config knows.
  const cloud = !machine && typeof sandboxProvider === "string";
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
  const label = runnerLocationLabel(sandboxId, sandboxProvider, runners, run.run_location);
  // The place is classified by its identity, never by the words: a machine may
  // be enrolled under any name, "Cloud" included.
  const vendor = machine ? null : sandboxVendorLabel(sandboxProvider, names);
  return {
    label,
    title: vendor ? `Runs on ${vendor}` : machine ? `Runs on ${label}` : "Runs in the cloud",
    icon: machine ? RiComputerLine : RiCloudLine,
  };
}

export function RunLocation({ run }: { readonly run: LocatedRun }) {
  const location = useRunLocationLabel(run);
  if (!location) return null;
  const Icon = location.icon;
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 text-caption-1-regular text-text-tertiary"
      title={location.title}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="max-w-36 truncate">{location.label}</span>
    </span>
  );
}
