"use client";

import { RiComputerLine } from "@remixicon/react";
import { useEffect, useState } from "react";
import { fetchRunners } from "./runner-api";
import { localRunnerId, type Runner, runnerLocationLabel } from "./runner-data";

export function RunLocation({
  run,
}: {
  readonly run: { readonly sandbox_id: string | null; readonly sandbox_provider?: unknown };
}) {
  const [runners, setRunners] = useState<Runner[]>([]);
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
  if (!sandboxId && !sandboxProvider) return null;
  return (
    <span
      className="flex min-w-0 items-center gap-1.5 text-caption-1-regular text-text-tertiary"
      title={`Runs on ${runnerLocationLabel(sandboxId, sandboxProvider, runners)}`}
    >
      <RiComputerLine aria-hidden className="size-3.5 shrink-0" />
      <span className="max-w-36 truncate">
        {runnerLocationLabel(sandboxId, sandboxProvider, runners)}
      </span>
    </span>
  );
}
