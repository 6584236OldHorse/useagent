import type { RunLocation } from "@useagent/agent-client/wire";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { runs, sandboxMinutesEntries } from "../db/schema";
import { userEmail } from "../provider-gateway/provider-accounts";
import { COMPUTER_PROVIDER_KINDS, userComputersEnabled } from "../sandboxes/binding";
import { accountOnList } from "../security/account-allowlist";

// ---------------------------------------------------------------------------
// Sandbox minutes allowance. Every person may hold the deployment's sandboxes
// for SANDBOX_MINUTES_PER_USER minutes (default 600) in all their organisations
// together, so a new organisation brings no new allowance. A run is charged
// ONCE when it settles, from the lifetimes of the capacity leases it held
// (created at admission, released at settlement, so idle time between turns of
// a retained thread is not charged); a person at or past the cap is refused new
// work that would land on the deployment's sandboxes, at acceptance, and a
// running turn is never cut off. Their own machine and their own Daytona or Box
// account cost the deployment nothing: never charged, never refused.
// SANDBOX_MINUTES_PER_USER=0 turns the cap off (the ledger keeps accruing).
// ---------------------------------------------------------------------------

/** The per-member cap in minutes; 0 (or an unusable value) disables it. */
export function sandboxMinutesPerUser(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SANDBOX_MINUTES_PER_USER?.trim();
  if (raw === undefined || raw === "") return 600;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export class SandboxMinutesExceededError extends Error {
  readonly code = "sandbox_minutes_exceeded" as const;

  constructor(readonly used: number, readonly cap: number) {
    super(
      `You have used ${used} of your ${cap} sandbox minutes. ` +
        "New tasks are paused until the cap is raised.",
    );
    this.name = "SandboxMinutesExceededError";
  }

  /** The refusal every ingress answers with. */
  get body() {
    return { error: this.code, message: this.message, used: this.used, cap: this.cap };
  }
}

/** A person's settled figures in every organisation: whole minutes used and the runs charged.
 *  ponytail: the ledger index leads with org_id, so this scans the table; add a
 *  user_id index (db/online-indexes) once the ledger is large. */
async function usedMinutes(userId: string, exec: Executor): Promise<{ used: number; runs: number }> {
  const [row] = await exec
    .select({
      seconds: sql<number>`coalesce(sum(${sandboxMinutesEntries.seconds}), 0)::bigint`,
      runs: sql<number>`count(*)::int`,
    })
    .from(sandboxMinutesEntries)
    .where(eq(sandboxMinutesEntries.userId, userId));
  return { used: Math.floor(Number(row?.seconds ?? 0) / 60), runs: Number(row?.runs ?? 0) };
}

/** Where new work will run, as far as the cap cares: the thread it continues
 *  (a reply reuses that thread's sandbox) and where the thread asked to run. */
export interface SandboxPlacement {
  readonly threadId?: string | null;
  readonly runLocation?: RunLocation | null;
}

/**
 * Refuse new work on the deployment's sandboxes for a person at or past the
 * cap. A plain read of the committed ledger, deliberately without a lock: the
 * acceptance transaction already holds thread and admission locks, and a charge
 * that commits a moment after this read is seen by the next acceptance, which
 * is all a cap on settled minutes can promise. Runs without a person behind
 * them pass. Past the cap, every further read goes through `exec`: a pool read
 * under an open transaction waits for a second connection, and enough of them
 * at once starve the pool.
 */
export async function assertSandboxMinutes(
  orgId: string,
  userId: string | null,
  exec: Executor = db,
  placement: SandboxPlacement = {},
): Promise<void> {
  const cap = sandboxMinutesPerUser();
  if (!userId || cap <= 0) return;
  const { used } = await usedMinutes(userId, exec);
  if (used < cap || !(await onDeploymentSandbox(orgId, userId, placement, exec))) return;
  // The accounts that run the deployment (OPERATOR_ACCOUNTS) are never capped;
  // an unset list exempts nobody, development included.
  if (accountOnList("OPERATOR_ACCOUNTS", await userEmail(userId, exec))) return;
  throw new SandboxMinutesExceededError(used, cap);
}

/**
 * Whether new work lands on a sandbox the deployment pays for, the way
 * acquireThreadSandbox places it: a thread on the person's machine stays there,
 * a reply reuses the thread's retained sandbox whoever's account it is on, and
 * a new sandbox is on the person's own Daytona or Box account when
 * USER_COMPUTERS is on and one is connected (the view lists only connected
 * API keys, and the gateway may read it).
 */
async function onDeploymentSandbox(
  orgId: string,
  userId: string,
  placement: SandboxPlacement,
  exec: Executor,
): Promise<boolean> {
  if (placement.runLocation === "local") return false;
  if (placement.threadId) {
    const [retained] = await exec
      .select({ credential: runs.sandboxCredential })
      .from(runs)
      .where(and(eq(runs.orgId, orgId), eq(runs.threadId, placement.threadId), isNotNull(runs.sandboxId)))
      .orderBy(desc(runs.createdAt), desc(runs.id))
      .limit(1);
    if (retained) return retained.credential !== "user";
  }
  if (!userComputersEnabled()) return true;
  const own = await exec.execute(sql`
    select 1 from gateway_provider_api_key_credentials
    where org_id = ${orgId} and user_id = ${userId} and provider in ${[...COMPUTER_PROVIDER_KINDS]}
    limit 1`);
  return own.length === 0;
}

/**
 * Charge a settled run to its member from the leases it held: each lease from
 * its creation to its release (a lease still open, e.g. one the reconciler is
 * reclaiming for a crashed worker, is charged up to now). Only a run that had
 * one of the deployment's sandboxes is charged; chat and mock runs hold no
 * sandbox, and a run on the person's machine or on their own Daytona or Box
 * account (recorded with the user credential) costs the deployment nothing.
 * Whole seconds are the floor of the summed lifetimes, so a fraction never
 * rounds a member into a minute early. Idempotent by run id: a second
 * settlement inserts nothing.
 * ponytail: a sandbox retained between turns is not charged for its idle time;
 * charge at teardown too if idle retention must count.
 */
export async function accrueRunSandboxMinutes(
  run: {
    readonly id: string;
    readonly orgId: string | null;
    readonly userId: string | null;
    readonly sandboxId: string | null;
    readonly sandboxCredential: "env" | "user" | null;
    readonly runLocation: RunLocation | null;
  },
  exec: Executor,
): Promise<boolean> {
  if (!run.orgId || !run.userId) return false;
  if (run.sandboxCredential === "user" || run.runLocation === "local") return false;
  const [held] = await exec.execute(sql`
    select
      floor(coalesce(sum(greatest(0, extract(epoch from
        coalesce(case when state = 'released' then updated_at end, now()) - created_at))), 0))::bigint as seconds,
      count(*)::int as sandboxes
    from sandbox_leases
    where run_id = ${run.id} and (sandbox_id is not null or ${run.sandboxId !== null})`);
  const sandboxes = Number(held?.sandboxes ?? 0);
  if (sandboxes === 0) return false;
  const inserted = await exec
    .insert(sandboxMinutesEntries)
    .values({
      chargeKey: run.id,
      orgId: run.orgId,
      userId: run.userId,
      seconds: Math.min(2_147_483_647, Number(held?.seconds ?? 0)),
      sandboxes,
    })
    .onConflictDoNothing()
    .returning({ chargeKey: sandboxMinutesEntries.chargeKey });
  return inserted.length > 0;
}

export interface SandboxMinutesSnapshot {
  readonly used: number;
  /** Null when the cap is off. */
  readonly cap: number | null;
  readonly runs: number;
}

/** The person's own figures across their organisations, the ones Settings > Usage shows. */
export async function sandboxMinutesSnapshot(userId: string | null): Promise<SandboxMinutesSnapshot> {
  const cap = sandboxMinutesPerUser();
  const figures = userId ? await usedMinutes(userId, db) : { used: 0, runs: 0 };
  return { ...figures, cap: cap > 0 ? cap : null };
}
