import type { ResolvedProviderCredential } from "../provider-gateway/credentials";
import { providerKeyLimitReason } from "../provider-gateway/key-limit";
import { recordProviderEvent } from "../runs/provider-events";
import { chargeSpend } from "../runs/spend";
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
    // A stream that ended normally is a model call even when the provider
    // named neither a generation nor usage: it is recorded (unpriced) rather
    // than skipped. A stream that broke before naming anything has nothing.
    if (account.usage || account.generationId || completed) {
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
        },
      });
    }
  }
}

/**
 * Charge one stateless chat turn (POST /api/chat, which has no run row) to the
 * member it served, under its own `chat:` key. Best effort by contract: a
 * failure to charge is logged, never thrown into the response stream.
 */
export async function chargeChatTurn(input: {
  readonly orgId: string;
  readonly userId: string | null;
  readonly account: ChatAccount;
  readonly credential: ResolvedProviderCredential;
  /** The stream ended normally: charged even without a figure, as an unpriced entry. */
  readonly completed?: boolean;
}): Promise<void> {
  if (!input.userId) return;
  if (!input.account.usage && !input.account.generationId && !input.completed) return;
  try {
    const charge = await settleChatCharge(input.account, input.credential);
    await chargeSpend({
      key: `chat:${crypto.randomUUID()}`,
      orgId: input.orgId,
      userId: input.userId,
      cost: charge.cost ?? 0,
      tokens: charge.tokens,
      source: charge.costSource === "provider_generation"
        ? "provider_generation"
        : charge.cost === null
          ? "unpriced"
          : "usage",
    });
  } catch (error) {
    console.error(`[spend] chat turn charge failed for ${input.orgId}/${input.userId}:`, errorMessage(error));
  }
}

/** What a failed chat turn records: a spent provider key is named plainly; any
 *  other error stays generic, so a raw provider error never persists from this lane. */
export function chatFailure(error: unknown): { readonly label: string; readonly reason: string } {
  const keyLimit = providerKeyLimitReason(errorMessage(error));
  return keyLimit
    ? { label: "Provider key limit reached", reason: keyLimit }
    : { label: "Chat error", reason: "chat request failed" };
}
