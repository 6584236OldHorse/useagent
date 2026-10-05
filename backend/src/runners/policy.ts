// Switches for local execution: the deployment-wide kill switch, the image the
// deployment names for runners, and the per-organisation policy row.

import { eq } from "drizzle-orm";
import { PROTOCOL_VERSION } from "@useagent/runner-protocol";
import { localImageFromEnv } from "@useagent/sandbox-local";
import { db } from "../db/client";
import { runnerPolicies } from "../db/schema";

/** `LOCAL_RUNNERS=off` (or 0 or false) removes local execution; unset means on. */
export function localRunnersEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const value = (env.LOCAL_RUNNERS ?? "").trim().toLowerCase();
  return !(value === "off" || value === "0" || value === "false");
}

/** The `runner` block of /api/config: what a runner must speak and boot. */
export function runnerConfigBlock(env: Readonly<Record<string, string | undefined>> = process.env) {
  return {
    enabled: localRunnersEnabled(env),
    minProtocol: PROTOCOL_VERSION,
    image: localImageFromEnv(env),
  };
}

export interface RunnerPolicy {
  readonly allowLocalExecution: boolean;
  readonly allowLocalLogins: boolean;
}

export const DEFAULT_RUNNER_POLICY: RunnerPolicy = { allowLocalExecution: true, allowLocalLogins: true };

export async function getRunnerPolicy(orgId: string): Promise<RunnerPolicy> {
  const [row] = await db.select().from(runnerPolicies).where(eq(runnerPolicies.orgId, orgId)).limit(1);
  return row ? { allowLocalExecution: row.allowLocalExecution, allowLocalLogins: row.allowLocalLogins } : DEFAULT_RUNNER_POLICY;
}

export async function setRunnerPolicy(orgId: string, policy: Partial<RunnerPolicy>): Promise<RunnerPolicy> {
  const current = await getRunnerPolicy(orgId);
  const next = { ...current, ...policy };
  await db
    .insert(runnerPolicies)
    .values({ orgId, allowLocalExecution: next.allowLocalExecution, allowLocalLogins: next.allowLocalLogins })
    .onConflictDoUpdate({
      target: runnerPolicies.orgId,
      set: { allowLocalExecution: next.allowLocalExecution, allowLocalLogins: next.allowLocalLogins, updatedAt: new Date() },
    });
  return next;
}
