import type { ResolvedProviderCredential } from "../provider-gateway/credentials";
import { providerKeyLimitReason } from "../provider-gateway/key-limit";
import { recordProviderEvent } from "../runs/provider-events";
import { errorMessage } from "../util/error-message";
import { fetchGenerationCost, streamChat, type ChatMessage, type ChatUsage } from "./stream";

export type { ChatMessage };

/**
 * The chat turn as the worker drives it: the model's deltas and then, once the
 * stream ends, the turn's real usage persisted BEFORE the caller settles the
 * run, so the settlement reads a priced turn. Usage lands as the same
 * `part.step-finish` event the sandboxed engines emit, so the Limits card,
 * Settings > Usage and the spend ledger price chat turns from one source. When
 * the deployment's own key served the turn, the provider's settled
 * per-generation figure is read back and wins over the streamed one;
 * `costSource` records which figure landed. Exactly one usage row per turn.
 */
export async function* chatTurnStream(
  run: { readonly id: string; readonly threadId: string; readonly model: string },
  messages: ChatMessage[],
  credential: ResolvedProviderCredential,
  signal: AbortSignal,
): AsyncGenerator<string, void, unknown> {
  let usage: ChatUsage | null = null;
  yield* streamChat(messages, run.model, credential.value, signal, (u) => {
    usage = u;
  });
  if (usage) await recordChatUsage(run, usage, credential);
}

async function recordChatUsage(
  run: { readonly id: string; readonly threadId: string },
  usage: ChatUsage,
  credential: ResolvedProviderCredential,
): Promise<void> {
  let cost = usage.cost ?? 0;
  let costSource: "stream_usage" | "provider_generation" = "stream_usage";
  if (credential.source === "backend_env" && usage.generationId) {
    const settled = await fetchGenerationCost(usage.generationId, credential.value);
    if (settled !== null) {
      cost = settled;
      costSource = "provider_generation";
    }
  }
  await recordProviderEvent({
    id: `${run.id}:chat:usage`,
    runId: run.id,
    threadId: run.threadId,
    provider: "chat",
    eventType: "part.step-finish",
    payload: {
      tokens: { total: usage.totalTokens },
      cost,
      costSource,
      generationId: usage.generationId,
    },
  });
}

/** What a failed chat turn records: a spent provider key is named plainly; any
 *  other error stays generic, so a raw provider error never persists from this lane. */
export function chatFailure(error: unknown): { readonly label: string; readonly reason: string } {
  const keyLimit = providerKeyLimitReason(errorMessage(error));
  return keyLimit
    ? { label: "Provider key limit reached", reason: keyLimit }
    : { label: "Chat error", reason: "chat request failed" };
}
