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

/**
 * A loader under which only the NEWEST request may report: mount, reconnect
 * and settlement refreshes overlap, and an older, slower response must never
 * undo a newer figure (a member would read "under the cap" while every
 * submission is refused). A failed request keeps the last good figure.
 */
export function spendLoader(
  fetchSpend: (signal?: AbortSignal) => Promise<SpendSnapshot | null>,
  report: (spend: SpendSnapshot) => void,
): (signal?: AbortSignal) => Promise<void> {
  let generation = 0;
  return async (signal) => {
    const mine = ++generation;
    try {
      const spend = await fetchSpend(signal);
      if (spend && mine === generation) report(spend);
    } catch {
      // Keep the last good figure.
    }
  };
}

export interface SpendReadTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/**
 * When a page's spend reads happen: one per page, taken once the org stream is open
 * so no settlement can land unseen between the read and the stream (the same rule the
 * sidebar's snapshot follows). If the stream is slow or blocked, the grace timer reads
 * anyway and the open that follows reads again; every later open (a reconnect) reads
 * again. Pure, so the sequence is testable.
 */
const HOST_TIMERS: SpendReadTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function scheduleSpendReads(
  read: () => void,
  graceMs: number,
  timers: SpendReadTimers = HOST_TIMERS,
): { streamOpened: () => void; stop: () => void } {
  let grace: unknown = timers.setTimeout(() => {
    grace = null;
    read();
  }, graceMs);
  const cancelGrace = (): void => {
    if (grace === null) return;
    timers.clearTimeout(grace);
    grace = null;
  };
  return {
    streamOpened() {
      cancelGrace();
      read();
    },
    stop: cancelGrace,
  };
}
