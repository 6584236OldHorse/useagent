import {
  ProviderCredentialMissingError,
  providerCredentialMissingMessage,
} from "../engines/provider-credential-gate";
import {
  credentialWaitSignal,
  resolveChatProviderCredential,
  type ProviderCredentialResolvers,
  type ResolvedProviderCredential,
} from "../provider-gateway/credentials";
import { awaitWithSignal } from "../util/abortable-operation";
import { providerKeyLimitReason } from "../provider-gateway/key-limit";
import { errorMessage } from "../util/error-message";
import { SafeChatInputError } from "./input";
import { SafeChatStreamError, streamChat, type ChatMessage } from "./stream";

export type { ChatMessage };

/** The member's connected OpenRouter key, else the organisation's secret, read
 *  on the run's own clock (Stop aborts the read; a blocked table cannot hold the
 *  run). Throws the remedy when neither exists, before any upstream work. */
export async function chatTurnCredential(
  run: { readonly orgId: string; readonly userId: string | null },
  signal: AbortSignal,
  deps: ProviderCredentialResolvers & {
    readonly resolve?: typeof resolveChatProviderCredential;
  } = {},
): Promise<ResolvedProviderCredential> {
  const resolve = deps.resolve ?? resolveChatProviderCredential;
  const resolved = await awaitWithSignal(
    () => resolve({ orgId: run.orgId, userId: run.userId }, deps),
    credentialWaitSignal(signal),
  );
  if (!resolved) {
    throw new ProviderCredentialMissingError(providerCredentialMissingMessage("chat", "openrouter"));
  }
  return resolved;
}

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

/** What a failed chat turn records: a missing or spent provider key is named
 *  plainly with its remedy; any other error stays generic, so a raw provider
 *  error never persists from this lane. */
export function chatFailure(error: unknown): { readonly label: string; readonly reason: string } {
  if (error instanceof ProviderCredentialMissingError) {
    return { label: "OpenRouter key needed", reason: error.message };
  }
  if (error instanceof SafeChatInputError) return { label: error.label, reason: error.reason };
  if (error instanceof SafeChatStreamError) {
    if (error.category === "authentication") {
      return { label: "Provider authentication failed", reason: "the configured chat provider credential was rejected" };
    }
    if (error.category === "credits") {
      return { label: "Provider credits required", reason: "the chat provider requires additional credits" };
    }
    if (error.category === "key_limit") {
      return {
        label: "Provider key limit reached",
        reason: providerKeyLimitReason("key limit exceeded") ?? "the chat provider key limit was reached",
      };
    }
    if (error.category === "policy") {
      return { label: "Provider policy rejected the request", reason: "the chat provider rejected the request by policy" };
    }
    if (error.category === "rate_limit") {
      return { label: "Provider rate limit reached", reason: "the chat provider rate limit was reached" };
    }
    return { label: "Provider unavailable", reason: "the chat provider is temporarily unavailable" };
  }
  const keyLimit = providerKeyLimitReason(errorMessage(error));
  return keyLimit
    ? { label: "Provider key limit reached", reason: keyLimit }
    : { label: "Chat error", reason: "chat request failed" };
}
