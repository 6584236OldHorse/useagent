import { and, eq, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { sandboxMinutesEntries } from "../db/schema";

// ---------------------------------------------------------------------------
// Sandbox minutes allowance. Every organisation member may hold sandboxes for
// SANDBOX_MINUTES_PER_USER minutes (default 600). A run is charged ONCE when it
// settles, from the lifetimes of the capacity leases it held (created at
// admission, released at settlement, so idle time between turns of a retained
// thread is not charged); a member at or past the cap is refused new sandbox
// work at acceptance, and a running turn is never cut off.
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

/** A member's settled figures: whole minutes used and the runs charged. */
async function usedMinutes(orgId: string, userId: string, exec: Executor): Promise<{ used: number; runs: number }> {
  const [row] = await exec
    .select({
      seconds: sql<number>`coalesce(sum(${sandboxMinutesEntries.seconds}), 0)::bigint`,
      runs: sql<number>`count(*)::int`,
    })
    .from(sandboxMinutesEntries)
    .where(and(eq(sandboxMinutesEntries.orgId, orgId), eq(sandboxMinutesEntries.userId, userId)));
  return { used: Math.floor(Number(row?.seconds ?? 0) / 60), runs: Number(row?.runs ?? 0) };
}

/**
 * Refuse new sandbox work for a member at or past the cap. A plain read of the
 * committed ledger, deliberately without a lock: the acceptance transaction
 * already holds thread and admission locks, and a charge that commits a moment
 * after this read is seen by the next acceptance, which is all a cap on
 * settled minutes can promise. Runs without a person behind them pass.
 */
export async function assertSandboxMinutes(orgId: string, userId: string | null, exec: Executor = db): Promise<void> {
  const cap = sandboxMinutesPerUser();
  if (!userId || cap <= 0) return;
  const { used } = await usedMinutes(orgId, userId, exec);
  if (used >= cap) throw new SandboxMinutesExceededError(used, cap);
}

/**
 * Charge a settled run to its member from the leases it held: each lease from
 * its creation to its release (a lease still open, e.g. one the reconciler is
 * reclaiming for a crashed worker, is charged up to now). Only a run that had
 * a sandbox is charged; chat and mock runs hold no sandbox and leave no entry.
 * Whole seconds are the floor of the summed lifetimes, so a fraction never
 * rounds a member into a minute early. Idempotent by run id: a second
 * settlement inserts nothing.
 * ponytail: a sandbox retained between turns is not charged for its idle time;
 * charge at teardown too if idle retention must count.
 */
export async function accrueRunSandboxMinutes(
  run: { readonly id: string; readonly orgId: string | null; readonly userId: string | null; readonly sandboxId: string | null },
  exec: Executor,
): Promise<boolean> {
  if (!run.orgId || !run.userId) return false;
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

/** The member's own figures, the ones Settings > Usage shows. */
export async function sandboxMinutesSnapshot(orgId: string, userId: string | null): Promise<SandboxMinutesSnapshot> {
  const cap = sandboxMinutesPerUser();
  const figures = userId ? await usedMinutes(orgId, userId, db) : { used: 0, runs: 0 };
  return { ...figures, cap: cap > 0 ? cap : null };
}
