import { chargeSpend, markUnresolvedSpend, noteSpendGeneration, pendingSpendCharges, type SpendFigure } from "../runs/spend";
import { errorMessage } from "../util/error-message";
import { fetchGenerationCost } from "./stream";
import { unsettledChatCharges } from "./turn";

// Chat charges left pending: a stateless chat turn opens its charge before the
// model call (routes.ts) and fills it in when the stream ends (turn.ts). What
// the ledger refused is retried here from the figure this process kept; what
// a dead process left behind is settled from the figure it had stored, else
// from the provider's own record of the generation; what nothing can price is
// unresolved: reported every sweep, counted on the member's account (which
// pauses their new work) until an operator settles it.

/** A charge still pending this long after it was opened is no longer a turn in flight. */
const CHAT_CHARGE_SWEEP_GRACE_MS = 30 * 60_000;
const CHAT_CHARGE_SWEEP_INTERVAL_MS = 60_000;

export interface ChatChargeSweep {
  readonly settled: number;
  readonly pending: number;
  /** Pending charges nothing can price: no stored figure, no readable provider record. Unresolved until an operator settles them. */
  readonly stuck: readonly string[];
}

export async function settlePendingChatCharges(graceMs = CHAT_CHARGE_SWEEP_GRACE_MS): Promise<ChatChargeSweep> {
  const houseKey = process.env.OPENROUTER_API_KEY;
  let settled = 0;
  // What this process could not write: retried with what it kept, until it lands.
  for (const [key, owed] of unsettledChatCharges) {
    try {
      if (owed.figure) {
        if (await chargeSpend({ key, orgId: owed.orgId, userId: owed.userId, ...owed.figure })) settled += 1;
      } else if (owed.generationId) {
        await noteSpendGeneration(key, owed.generationId);
      }
      unsettledChatCharges.delete(key);
    } catch (error) {
      console.error(`[spend] chat charge ${key} (${owed.orgId}/${owed.userId}) still cannot be written:`, errorMessage(error));
    }
  }
  // What the ledger holds past the grace: from the stored figure, else the
  // provider's record read with the deployment key, else reported.
  const rows = await pendingSpendCharges(new Date(Date.now() - graceMs));
  const stuck: string[] = [];
  const unresolved: Array<{ orgId: string; userId: string }> = [];
  let settledRows = 0;
  for (const row of rows) {
    if (unsettledChatCharges.has(row.key)) continue; // still this process's to write
    let figure: SpendFigure | null = row.figure;
    if (!figure && row.generationId && houseKey) {
      const cost = await fetchGenerationCost(row.generationId, houseKey);
      if (cost !== null) figure = { cost, tokens: 0, source: "provider_generation", generationId: row.generationId };
    }
    if (!figure) {
      stuck.push(row.key);
      unresolved.push({ orgId: row.orgId, userId: row.userId });
      console.error(`[spend] chat charge ${row.key} (${row.orgId}/${row.userId}) is unresolved: no figure was stored and no provider record prices it; the member's new work is paused until it is settled by hand`);
      continue;
    }
    if (await chargeSpend({ key: row.key, orgId: row.orgId, userId: row.userId, ...figure })) settledRows += 1;
  }
  await markUnresolvedSpend(unresolved);
  settled += settledRows;
  const pending = rows.length - settledRows;
  if (rows.length > 0 || unsettledChatCharges.size > 0) {
    console.warn(`[spend] chat charge sweep: ${settled} settled, ${pending} still pending, ${stuck.length} stuck, ${unsettledChatCharges.size} kept by this process`);
  }
  return { settled, pending, stuck };
}

/** The sweep at boot (a restart is exactly when a charge was left behind) and every minute after. */
export function startChatChargeSweep(): void {
  const tick = () => {
    settlePendingChatCharges().catch((error) => {
      console.error("[spend] chat charge sweep failed:", errorMessage(error));
    });
  };
  tick();
  const timer = setInterval(tick, CHAT_CHARGE_SWEEP_INTERVAL_MS);
  timer.unref?.();
}
