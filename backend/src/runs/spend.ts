import { and, eq, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { spendAccounts, spendEntries, type SpendSource } from "../db/schema";

// ---------------------------------------------------------------------------
// Spend allowance. Every organisation member may spend SPEND_ALLOWANCE_USD
// (default 100) of settled model cost. A run is charged ONCE when it settles,
// from the real cost its usage events carry; a member at or past the allowance
// is refused new runs at acceptance, and a running turn is never cut off.
// SPEND_ALLOWANCE_USD=0 turns the cap off (the ledger keeps accruing).
// ---------------------------------------------------------------------------

/** The deployment-wide allowance in USD; 0 (or an unusable value) disables the cap. */
export function spendAllowanceDefaultUsd(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SPEND_ALLOWANCE_USD?.trim();
  if (raw === undefined || raw === "") return 100;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

export class SpendAllowanceExceededError extends Error {
  readonly code = "spend_allowance_exceeded" as const;

  constructor(readonly spent: number, readonly allowance: number) {
    super(
      `You have spent ${usd(spent)} of your ${usd(allowance)} allowance. ` +
        "New tasks are paused until it is raised.",
    );
    this.name = "SpendAllowanceExceededError";
  }

  /** The refusal every ingress answers with. */
  get body() {
    return { error: this.code, message: this.message, spent: this.spent, allowance: this.allowance };
  }
}

/** The member's ledger row, created on first touch and locked for the transaction. */
async function lockAccount(orgId: string, userId: string, tx: Executor) {
  await tx.insert(spendAccounts).values({ orgId, userId }).onConflictDoNothing();
  const [row] = await tx
    .select({ allowanceUsd: spendAccounts.allowanceUsd, spentUsd: spendAccounts.spentUsd })
    .from(spendAccounts)
    .where(and(eq(spendAccounts.orgId, orgId), eq(spendAccounts.userId, userId)))
    .for("update");
  return row!;
}

/**
 * Refuse new work for a member at or past the allowance. Call inside the run
 * acceptance transaction: the row lock orders the check against a settling
 * run's charge, so it never reads a figure mid-update. Runs without a person
 * behind them have nothing to charge and pass.
 */
export async function assertSpendAllowance(
  orgId: string,
  userId: string | null,
  tx: Executor,
): Promise<void> {
  const fallback = spendAllowanceDefaultUsd();
  if (!userId || fallback <= 0) return;
  const account = await lockAccount(orgId, userId, tx);
  const allowance = account.allowanceUsd ?? fallback;
  if (account.spentUsd >= allowance) {
    throw new SpendAllowanceExceededError(account.spentUsd, allowance);
  }
}

/**
 * Charge a settled run once. The figure is the cost its `part.step-finish`
 * usage events carry: the engine's own figure, or the provider's settled
 * per-generation figure when the turn read one back (the events say which).
 * The per-run entry is the guard: a second settlement or a replayed finalize
 * inserts nothing and charges nothing.
 */
export async function accrueRunSpend(
  run: { readonly id: string; readonly orgId: string | null; readonly userId: string | null },
  tx: Executor,
): Promise<void> {
  if (!run.orgId || !run.userId) return;
  const [usage] = (await tx.execute(sql`
    select coalesce(sum((payload::jsonb ->> 'cost')::numeric), 0)::float8 as cost,
      coalesce(bool_or(payload::jsonb ->> 'costSource' = 'provider_generation'), false) as settled
    from provider_events
    where run_id = ${run.id} and event_type = 'part.step-finish'
  `)) as unknown as Array<{ cost: number; settled: boolean }>;
  const cost = Number(usage?.cost ?? 0);
  const source: SpendSource = usage?.settled ? "provider_generation" : "step_finish";
  const inserted = await tx
    .insert(spendEntries)
    .values({ runId: run.id, orgId: run.orgId, userId: run.userId, costUsd: cost, source })
    .onConflictDoNothing()
    .returning({ runId: spendEntries.runId });
  if (inserted.length === 0) return; // already charged
  await tx
    .insert(spendAccounts)
    .values({ orgId: run.orgId, userId: run.userId, spentUsd: cost, runs: 1 })
    .onConflictDoUpdate({
      target: [spendAccounts.orgId, spendAccounts.userId],
      set: {
        spentUsd: sql`${spendAccounts.spentUsd} + ${cost}::numeric`,
        runs: sql`${spendAccounts.runs} + 1`,
        updatedAt: new Date(),
      },
    });
}

export interface SpendSnapshot {
  readonly spent: number;
  /** Null when the cap is off. */
  readonly allowance: number | null;
  readonly runs: number;
}

/** The member's own figures. */
export async function spendSnapshot(orgId: string, userId: string | null): Promise<SpendSnapshot> {
  const fallback = spendAllowanceDefaultUsd();
  const [row] = userId
    ? await db
        .select({
          allowanceUsd: spendAccounts.allowanceUsd,
          spentUsd: spendAccounts.spentUsd,
          runs: spendAccounts.runs,
        })
        .from(spendAccounts)
        .where(and(eq(spendAccounts.orgId, orgId), eq(spendAccounts.userId, userId)))
        .limit(1)
    : [];
  return {
    spent: row?.spentUsd ?? 0,
    allowance: fallback > 0 ? (row?.allowanceUsd ?? fallback) : null,
    runs: row?.runs ?? 0,
  };
}
