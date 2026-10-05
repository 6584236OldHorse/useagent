import { chargeSpend, pendingSpendCharges } from "../runs/spend";
import { errorMessage } from "../util/error-message";
import { fetchGenerationCost } from "./stream";

// Chat charges left pending: a stateless chat turn opens its charge before the
// model call (routes.ts) and fills it in when the stream ends (turn.ts). What
// the process never completed (a crash, a database failure past the retries)
// is settled here from the provider's own record of the generation.

/** A charge still pending this long after it was opened is no longer a turn in flight. */
const CHAT_CHARGE_SWEEP_GRACE_MS = 30 * 60_000;
const CHAT_CHARGE_SWEEP_INTERVAL_MS = 10 * 60_000;

/**
 * Settle chat charges left pending by a completion that never wrote (a crash,
 * a database failure past the retries) from the provider's own record of the
 * generation, read with the deployment key; the stream's token count is gone
 * with the process, so the record's cost stands alone. A charge with no
 * generation id (a stream that never named one) or one whose record the
 * deployment key cannot read (a member's own key) stays pending: nothing can
 * price it, and the count is logged.
 */
export async function settlePendingChatCharges(
  graceMs = CHAT_CHARGE_SWEEP_GRACE_MS,
): Promise<{ readonly settled: number; readonly pending: number }> {
  const houseKey = process.env.OPENROUTER_API_KEY;
  const rows = await pendingSpendCharges(new Date(Date.now() - graceMs));
  let settled = 0;
  for (const row of rows) {
    if (!row.generationId || !houseKey) continue;
    const cost = await fetchGenerationCost(row.generationId, houseKey);
    if (cost === null) continue;
    const charged = await chargeSpend({
      key: row.key, orgId: row.orgId, userId: row.userId,
      cost, tokens: 0, source: "provider_generation", generationId: row.generationId,
    });
    if (charged) settled += 1;
  }
  const pending = rows.length - settled;
  if (rows.length > 0) {
    console.warn(`[spend] chat charge sweep: ${settled} settled from the provider's record, ${pending} still pending`);
  }
  return { settled, pending };
}

/** The sweep at boot (a restart is exactly when a charge was left behind) and every ten minutes after. */
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
