// `run_location` at the run-creation boundary: where a person asked a new
// thread to run. "cloud" is the hosted provider (the member's preference, else
// the deployment default). "local" is their connected machine, which must be
// allowed and connected when the choice is made, so the answer is a plain 409
// now rather than a failed run later. Absent means the cloud: the control plane
// never places a run on a machine nobody chose. A reply carries no choice; the
// insert copies its thread's (commands/repo.ts) and the sandbox it retains keeps
// the provider that made it.

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
  | {
      readonly ok: false;
      readonly status: 400 | 409;
      readonly body: { readonly error: string; readonly reason?: string };
    };

export const MACHINE_NOT_CONNECTED_REASON =
  "Your machine is not connected. Open the desktop app to connect it, or run this on the cloud.";

function isRunLocation(value: unknown): value is RunLocation {
  return typeof value === "string" && (RUN_LOCATIONS as readonly string[]).includes(value);
}

function localExecutionDisabled(by: "deployment" | "organisation"): RunLocationChoice {
  return {
    ok: false,
    status: 409,
    body: {
      error: "local_execution_disabled",
      reason: `Local execution is switched off for this ${by}, so this can only run on the cloud.`,
    },
  };
}

export async function runLocationChoice(
  value: unknown,
  scope: { readonly orgId: string; readonly userId: string | null; readonly reply: boolean },
  deps: RunLocationDeps = {},
): Promise<RunLocationChoice> {
  if (scope.reply) return { ok: true, runLocation: undefined };
  if (value === undefined || value === null) return { ok: true, runLocation: null };
  if (!isRunLocation(value)) {
    return { ok: false, status: 400, body: { error: `run_location must be one of: ${RUN_LOCATIONS.join(", ")}` } };
  }
  if (value === "cloud") return { ok: true, runLocation: "cloud" };
  if (!localRunnersEnabled(deps.env)) return localExecutionDisabled("deployment");
  if (!(await (deps.policy ?? getRunnerPolicy)(scope.orgId)).allowLocalExecution) {
    return localExecutionDisabled("organisation");
  }
  const online =
    deps.machineOnline ?? ((orgId: string, userId: string) => activeRunnerSeam().onlineForUser(orgId, userId) !== null);
  if (!scope.userId || !online(scope.orgId, scope.userId)) {
    return { ok: false, status: 409, body: { error: "machine_not_connected", reason: MACHINE_NOT_CONNECTED_REASON } };
  }
  return { ok: true, runLocation: "local" };
}
