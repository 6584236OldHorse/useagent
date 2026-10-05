import type { ResolvedProviderCredential } from "../provider-gateway/credentials";
import { providerKeyLimitReason } from "../provider-gateway/key-limit";
import { recordProviderEvent } from "../runs/provider-events";
import { chargeSpend, discardSpendCharge, noteSpendFigure, noteSpendGeneration, type SpendFigure } from "../runs/spend";
import { errorMessage } from "../util/error-message";
import {
  fetchGenerationCost,
  newChatAccount,
  streamChat,
  type ChatAccount,
  type ChatMessage,
} from "./stream";

export type { ChatMessage };

/** How a chat turn's figure was settled. */
export type ChatCostSource = "stream_usage" | "provider_generation" | "unpriced";

export interface ChatCharge {
  /** USD; null when nothing priced the turn. */
  readonly cost: number | null;
  readonly tokens: number;
  readonly costSource: ChatCostSource;
}

/**
 * The figure a chat turn is charged, however the stream ended. When the
 * deployment's own key served the turn and the provider named the generation,
 * the settled per-generation figure is read back and wins over the streamed
 * one (this also prices a stream that broke after the provider had started
 * billing it). A turn nothing priced is `unpriced`, never a silent zero.
 */
export async function settleChatCharge(
  account: ChatAccount,
  credential: ResolvedProviderCredential,
): Promise<ChatCharge> {
  const tokens = account.usage?.totalTokens ?? 0;
  if (credential.source === "backend_env" && account.generationId) {
    const settled = await fetchGenerationCost(account.generationId, credential.value);
    if (settled !== null) return { cost: settled, tokens, costSource: "provider_generation" };
  }
  if (account.usage?.cost != null) return { cost: account.usage.cost, tokens, costSource: "stream_usage" };
  return { cost: null, tokens, costSource: "unpriced" };
}

/**
 * The chat turn as the worker drives it: the model's deltas and then, however
 * the stream ends (complete, failed, or stopped by the consumer), the turn's
 * usage persisted BEFORE control returns to the caller, so the settlement
 * reads a priced turn. Usage lands as the same `part.step-finish` event the
 * sandboxed engines emit, so the Limits card, Settings > Usage and the spend
 * ledger price chat turns from one source. Exactly one usage row per turn.
 */
export async function* chatTurnStream(
  run: { readonly id: string; readonly threadId: string; readonly model: string },
  messages: ChatMessage[],
  credential: ResolvedProviderCredential,
  signal: AbortSignal,
): AsyncGenerator<string, void, unknown> {
  const account = newChatAccount();
  let completed = false;
  try {
    yield* streamChat(messages, run.model, credential.value, signal, account);
    completed = true;
  } finally {
    // A request the provider accepted is a model call even when it named
    // neither a generation nor usage before the stream ended: it is recorded
    // (the settlement leaves an unpriced one open for the sweep rather than
    // charging a zero). A request the provider never accepted has nothing.
    if (account.usage || account.generationId || account.accepted || completed) {
      const charge = await settleChatCharge(account, credential);
      await recordProviderEvent({
        id: `${run.id}:chat:usage`,
        runId: run.id,
        threadId: run.threadId,
        provider: "chat",
        eventType: "part.step-finish",
        payload: {
          tokens: { total: charge.tokens },
          ...(charge.cost === null ? {} : { cost: charge.cost }),
          costSource: charge.costSource,
          generationId: account.generationId,
          accepted: account.accepted,
          completed,
        },
      });
    }
  }
}

/** A ledger write is retried this often before it is left to the sweep. */
const CHAT_WRITE_ATTEMPTS = 3;
const CHAT_WRITE_RETRY_MS = 500;

const usd = (n: number): string => `$${n.toFixed(4)}`;

/** What this process still owes the ledger for a chat charge it could not
 *  write: the generation the stream named and, once the stream ended, the
 *  figure. The sweep (charge-sweep.ts) keeps retrying these until they land;
 *  only a process death loses them, and the sweep then reports the entry. */
export interface UnsettledChatCharge {
  readonly orgId: string;
  readonly userId: string;
  readonly generationId: string | null;
  readonly figure: SpendFigure | null;
}
export const unsettledChatCharges = new Map<string, UnsettledChatCharge>();

/** One ledger write, retried; false once the attempts are spent (every failure logged). */
async function persistChatWrite(what: string, write: () => Promise<unknown>): Promise<boolean> {
  for (let attempt = 1; attempt <= CHAT_WRITE_ATTEMPTS; attempt += 1) {
    try {
      await write();
      return true;
    } catch (error) {
      console.error(`[spend] ${what}: write ${attempt}/${CHAT_WRITE_ATTEMPTS} failed:`, errorMessage(error));
      if (attempt < CHAT_WRITE_ATTEMPTS) await Bun.sleep(CHAT_WRITE_RETRY_MS * attempt);
    }
  }
  return false;
}

/** Note the generation the stream named on the open charge, retried; a note
 *  that never lands is remembered so the sweep can still write it. */
export async function noteChatGeneration(charge: {
  readonly key: string;
  readonly orgId: string;
  readonly userId: string;
}, generationId: string): Promise<void> {
  const landed = await persistChatWrite(`chat charge ${charge.key} generation`, () => noteSpendGeneration(charge.key, generationId));
  if (!landed && !unsettledChatCharges.has(charge.key)) {
    unsettledChatCharges.set(charge.key, { orgId: charge.orgId, userId: charge.userId, generationId, figure: null });
  }
}

/**
 * Charge one stateless chat turn (POST /api/chat, which has no run row) to the
 * member it served. The entry opened under `key` before the model call first
 * has its settled figure stored on it, then is settled (filled in and the
 * account moved, in one transaction), each write retried. What still did not
 * land is remembered, with its figure, for the sweep to write once the ledger
 * answers again; nothing is thrown into the response stream. A stream that
 * never named anything made no model call: its open charge is dropped.
 */
export async function chargeChatTurn(input: {
  readonly key: string;
  readonly orgId: string;
  readonly userId: string;
  readonly account: ChatAccount;
  readonly credential: ResolvedProviderCredential;
  /** The stream ended normally: charged even without a figure, as an unpriced entry. */
  readonly completed?: boolean;
}): Promise<void> {
  const where = `chat charge ${input.key} (${input.orgId}/${input.userId})`;
  if (!input.account.usage && !input.account.generationId && !input.account.accepted && !input.completed) {
    unsettledChatCharges.delete(input.key);
    await discardSpendCharge(input.key).catch((error) => {
      console.error(`[spend] ${where} was never billed and could not be dropped:`, errorMessage(error));
    });
    return;
  }
  const charge = await settleChatCharge(input.account, input.credential);
  if (charge.cost === null && (input.account.generationId || (input.account.accepted && !input.completed))) {
    // Billed (the provider named a generation, or accepted a request whose
    // stream then broke) but not priced here: the stream broke before its
    // usage or before its first frame, the record is not up yet, or a member's
    // own key served it and cannot be read back. Never a zero: the entry stays
    // pending with what is known, and the sweep prices it from the provider's
    // record or counts it unresolved. A stream that completed naming nothing
    // has nothing to price and settles unpriced below.
    const generationId = input.account.generationId;
    if (generationId) {
      const noted = await persistChatWrite(`${where} generation`, () => noteSpendGeneration(input.key, generationId));
      if (!noted && !unsettledChatCharges.has(input.key)) {
        unsettledChatCharges.set(input.key, { orgId: input.orgId, userId: input.userId, generationId, figure: null });
      }
    }
    console.warn(`[spend] ${where} is billed but not priced yet; left pending${generationId ? ` with generation ${generationId}` : " with no generation"} for the sweep`);
    return;
  }
  const figure: SpendFigure = {
    cost: charge.cost ?? 0,
    tokens: charge.tokens,
    source: charge.costSource === "provider_generation"
      ? "provider_generation"
      : charge.cost === null
        ? "unpriced"
        : "usage",
    generationId: input.account.generationId,
  };
  // The figure first, on its own: a settlement the ledger refuses after this
  // still leaves the sweep a stored figure, whichever key served the turn.
  await persistChatWrite(`${where} figure`, () => noteSpendFigure(input.key, figure));
  const settled = await persistChatWrite(`${where} settlement of ${usd(figure.cost)}`, () =>
    chargeSpend({ key: input.key, orgId: input.orgId, userId: input.userId, ...figure }));
  if (settled) {
    unsettledChatCharges.delete(input.key);
    return;
  }
  unsettledChatCharges.set(input.key, { orgId: input.orgId, userId: input.userId, generationId: figure.generationId, figure });
  console.error(`[spend] ${where} of ${usd(figure.cost)} is left to the sweep`);
}

/** What a failed chat turn records: a spent provider key is named plainly; any
 *  other error stays generic, so a raw provider error never persists from this lane. */
export function chatFailure(error: unknown): { readonly label: string; readonly reason: string } {
  const keyLimit = providerKeyLimitReason(errorMessage(error));
  return keyLimit
    ? { label: "Provider key limit reached", reason: keyLimit }
    : { label: "Chat error", reason: "chat request failed" };
}
