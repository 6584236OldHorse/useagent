import { cpus, loadavg, totalmem } from "node:os";
import type { RunnerCapacity } from "@useagent/runner-protocol";

/** What this machine lends: all but one CPU, three quarters of memory. */
export function machineCapacity(sandboxes: number, maxSandboxes: number): RunnerCapacity {
  const cpu = Math.max(1, cpus().length - 1);
  const memoryMb = Math.max(1024, Math.floor((totalmem() / (1024 * 1024)) * 0.75));
  return { cpu, memoryMb, sandboxes, maxSandboxes };
}

export function machineLoad(): number {
  return loadavg()[0] ?? 0;
}
