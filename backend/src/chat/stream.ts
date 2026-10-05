/**
 * OpenRouter STREAMING chat client for the lightweight Chat surface (#122).
 *
 * The no-sandbox conversational page talks to a model directly - instant, cheap.
 * This mirrors the wiki-gen client (src/wiki-gen/llm.ts): same Bearer key, base
 * URL, and attribution headers, but sets `stream: true` and yields text deltas as
 * they arrive by parsing the SSE `data:` lines. Never buffers the whole response.
 */
import { providerKeyLimitReason } from "../provider-gateway/key-limit";
import { responseBodyPrefix } from "../provider-gateway/retry";
import type { ChatContentPart } from "./input";

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string | readonly ChatContentPart[];
}

export class ChatStreamError extends Error {}

export type SafeChatStreamErrorCategory =
  | "authentication"
  | "credits"
  | "key_limit"
  | "policy"
  | "rate_limit"
  | "availability";

export class SafeChatStreamError extends Error {
  constructor(
    readonly status: number,
    readonly category: SafeChatStreamErrorCategory,
  ) {
    super(`chat provider ${category} error`);
    this.name = "SafeChatStreamError";
  }
}

type OpenRouterMessage = {
  readonly role: ChatMessage["role"];
  readonly content: string | readonly (
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image_url"; readonly image_url: { readonly url: string } }
  )[];
};

export function openRouterMessages(messages: readonly ChatMessage[]): OpenRouterMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content: typeof message.content === "string"
      ? message.content
      : message.content.map((part) => part.type === "text"
        ? part
        : {
            type: "image_url" as const,
            image_url: {
              url: `data:${part.contentType};base64,${Buffer.from(part.bytes).toString("base64")}`,
            },
          }),
  }));
}

function safeStatusError(status: number, keyLimit = false): SafeChatStreamError {
  if (status === 401) return new SafeChatStreamError(status, "authentication");
  if (status === 402) return new SafeChatStreamError(status, "credits");
  if (keyLimit) return new SafeChatStreamError(status, "key_limit");
  if (status === 403) return new SafeChatStreamError(status, "policy");
  if (status === 429) return new SafeChatStreamError(status, "rate_limit");
  return new SafeChatStreamError(status, "availability");
}

// A current OpenRouter slug. Older slugs like `anthropic/claude-3.7-sonnet` 404
// ("No endpoints found"). Override with CHAT_MODEL if a deployment wants a
// different model.
const DEFAULT_CHAT_MODEL = "anthropic/claude-sonnet-5";

/** Chat is offered unless the deployment turns it off (CHAT=off). Each turn
 * runs on the member's own OpenRouter key or the organisation's stored secret,
 * never on a key the deployment holds, so no key is needed to offer it. */
export function chatLlmEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.CHAT?.trim().toLowerCase() !== "off";
}

/**
 * The model the Chat surface talks to when the caller does not pick one.
 * `CHAT_MODEL` wins; otherwise a solid Claude model reachable via OpenRouter.
 * (A deployment that already runs the wiki/distiller pipeline can point
 * `CHAT_MODEL` at `wikiModel()`'s value to reuse the same model.)
 */
export function chatModel(
  env: Record<string, string | undefined> = process.env,
): string {
  return env.CHAT_MODEL?.trim() || DEFAULT_CHAT_MODEL;
}

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
  error?: { message?: string };
}

/**
 * Stream a chat completion from OpenRouter, yielding text deltas as they arrive.
 * `apiKey` is the credential resolved by the caller (the member's connected
 * OpenRouter key, else the organisation's secret) - this function never picks a
 * key, so an invalid key surfaces the real OpenRouter error rather than falling
 * back to another. Throws ChatStreamError when no key is passed or the call
 * fails; the caller surfaces that as an SSE `error` frame. `signal` aborts the
 * fetch (used for the client's Stop control).
 */
export async function* streamChat(
  messages: ChatMessage[],
  model: string,
  apiKey: string,
  signal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
  if (!apiKey) throw new ChatStreamError("no OpenRouter credential resolved");

  const baseUrl = process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/useagenthq/useagent",
      "X-Title": "useAgent Chat",
    },
    body: JSON.stringify({ model, messages: openRouterMessages(messages), stream: true }),
    signal,
  });
  if (!res.ok || !res.body) {
    if ([401, 402, 403, 429].includes(res.status) || res.status >= 500) {
      const keyLimit = res.status === 403 && providerKeyLimitReason(
        await responseBodyPrefix(res),
      ) !== null;
      throw safeStatusError(res.status, keyLimit);
    }
    throw new ChatStreamError("chat provider request failed");
  }

  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  // Buffer partial reads: an SSE `data:` line can be split across chunk
  // boundaries, so only complete lines (up to a newline) are parsed.
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        if (!line.startsWith("data:")) continue; // skip `:` keep-alive comments
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const chunk = JSON.parse(data) as StreamChunk;
          if (chunk.error) throw new ChatStreamError("chat provider stream failed");
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) yield delta;
        } catch (e) {
          if (e instanceof ChatStreamError) throw e;
          // A non-JSON keep-alive / partial line: ignore; the buffer reassembles.
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
