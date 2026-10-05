/**
 * The signed-in member's settled spend against their allowance, from the real
 * backend GET /api/spend. Pure: no React, so the composer chip and Settings
 * share one reading of the figures.
 */

export interface SpendSnapshot {
  readonly spent: number;
  /** Null when the deployment runs without a cap. */
  readonly allowance: number | null;
  readonly runs: number;
}

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Normalize GET /api/spend; null on an unusable shape (keep the last good figure). */
export function parseSpend(data: unknown): SpendSnapshot | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const spent = finite(d.spent);
  if (spent === null) return null;
  return { spent, allowance: finite(d.allowance), runs: finite(d.runs) ?? 0 };
}

/** "$100" when whole, "$12.34" otherwise. */
export function money(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

/** "Spent $12.34 of $100"; without a cap, just what was spent. */
export function spendLabel(spend: SpendSnapshot): string {
  const spent = `$${spend.spent.toFixed(2)}`;
  return spend.allowance === null ? `Spent ${spent}` : `Spent ${spent} of ${money(spend.allowance)}`;
}

export function spendCapped(spend: SpendSnapshot): boolean {
  return spend.allowance !== null && spend.spent >= spend.allowance;
}
