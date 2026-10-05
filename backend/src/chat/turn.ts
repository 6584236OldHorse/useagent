import type { ResolvedProviderCredential } from "../provider-gateway/credentials";
import { providerKeyLimitReason } from "../provider-gateway/key-limit";
import { errorMessage } from "../util/error-message";
import { streamChat, type ChatMessage } from "./stream";

export type { ChatMessage };

/**
 * The chat turn as the worker drives it: the model's deltas under the
 * credential the caller resolved. Not metered yet: a chat turn's usage is
 * neither recorded nor charged to the allowance (the follow-up prices chat
 * from the provider's generation records).
 */
export async function* chatTurnStream(
  run: { readonly model: string },
  messages: ChatMessage[],
  credential: ResolvedProviderCredential,
  signal: AbortSignal,
): AsyncGenerator<string, void, unknown> {
  yield* streamChat(messages, run.model, credential.value, signal);
}

/** What a failed chat turn records: a spent provider key is named plainly; any
 *  other error stays generic, so a raw provider error never persists from this lane. */
export function chatFailure(error: unknown): { readonly label: string; readonly reason: string } {
  const keyLimit = providerKeyLimitReason(errorMessage(error));
  return keyLimit
    ? { label: "Provider key limit reached", reason: keyLimit }
    : { label: "Chat error", reason: "chat request failed" };
}
