// `run_location` at the run-creation boundary: where a person asked a new
// thread to run. "cloud" is the hosted provider (the member's preference, else
// the deployment default). "local" is their connected machine, which must be
// allowed and connected when the request is first accepted, so the answer is a
// plain 409 now rather than a failed run later. Absent means the cloud: the
// control plane never places a run on a machine nobody chose. A reply carries
// no choice; the insert copies its thread's (commands/repo.ts) and the sandbox
// it retains keeps the provider that made it.

import { RUN_LOCATIONS, type RunLocation } from "@useagent/agent-client/wire";
import { activeRunnerSeam } from "../runners/directory";
import { getRunnerPolicy, localRunnersEnabled } from "../runners/policy";

export interface RunLocationDeps {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Whether the person has a machine connected that can take work (default: this process's runner view). */
  readonly machineOnline?: (orgId: string, userId: string) => boolean;
  readonly policy?: (orgId: string) => Promise<{ readonly allowLocalExecution: boolean }>;
}

export type RunLocationChoice =
  /** `undefined` on a reply (the insert copies the thread's), null when no choice was made. */
  | { readonly ok: true; readonly runLocation: RunLocation | null | undefined }
  | { readonly ok: false; readonly status: 400; readonly body: { readonly error: string } };

/** Why the machine cannot take the work right now. */
export interface MachineRefusal {
  readonly status: 409;
  readonly body: { readonly error: string; readonly reason: string };
}

export const MACHINE_NOT_CONNECTED_REASON =
  "Your machine is not connected. Open the desktop app to connect it, or run this on the cloud.";

function isRunLocation(value: unknown): value is RunLocation {
  return typeof value === "string" && (RUN_LOCATIONS as readonly string[]).includes(value);
}

/** The parsed choice; only the value is read here. Whether the machine can take
 *  the work is asked of a genuinely new acceptance (machineUnavailable). */
export function runLocationChoice(value: unknown, reply: boolean): RunLocationChoice {
  if (reply) return { ok: true, runLocation: undefined };
  if (value === undefined || value === null) return { ok: true, runLocation: null };
  if (!isRunLocation(value)) {
    return { ok: false, status: 400, body: { error: `run_location must be one of: ${RUN_LOCATIONS.join(", ")}` } };
  }
  return { ok: true, runLocation: value };
}

function localExecutionDisabled(by: "deployment" | "organisation"): MachineRefusal {
  return {
    status: 409,
    body: {
      error: "local_execution_disabled",
      reason: `Local execution is switched off for this ${by}, so this can only run on the cloud.`,
    },
  };
}

/** Why "local" cannot be honoured, or null when it can: the deployment and the
 *  organisation must allow local execution and the person's machine must be
 *  connected. Asked after the keyed replay lookup, like every other readiness
 *  check, so an already accepted request replays whatever the machine is doing. */
export async function machineUnavailable(
  scope: { readonly orgId: string; readonly userId: string | null },
  deps: RunLocationDeps = {},
): Promise<MachineRefusal | null> {
  if (!localRunnersEnabled(deps.env)) return localExecutionDisabled("deployment");
  if (!(await (deps.policy ?? getRunnerPolicy)(scope.orgId)).allowLocalExecution) {
    return localExecutionDisabled("organisation");
  }
  const online =
    deps.machineOnline ?? ((orgId: string, userId: string) => activeRunnerSeam().onlineForUser(orgId, userId) !== null);
  if (!scope.userId || !online(scope.orgId, scope.userId)) {
    return { status: 409, body: { error: "machine_not_connected", reason: MACHINE_NOT_CONNECTED_REASON } };
  }
  return null;
}
