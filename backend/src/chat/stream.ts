/**
 * OpenRouter STREAMING chat client for the lightweight Chat surface (#122).
 *
 * The no-sandbox conversational page talks to a model directly - instant, cheap.
 * This mirrors the wiki-gen client (src/wiki-gen/llm.ts): same Bearer key, base
 * URL, and attribution headers, but sets `stream: true` and yields text deltas as
 * they arrive by parsing the SSE `data:` lines. Never buffers the whole response.
 */
import type { ChatMessage } from "../wiki-gen/llm";

export type { ChatMessage };

export class ChatStreamError extends Error {}

// A served, current slug on our OpenRouter key (verified against /models). Older
// slugs like `anthropic/claude-3.7-sonnet` 404 ("No endpoints found") on this key.
// Override with CHAT_MODEL if a deployment wants a different model.
const DEFAULT_CHAT_MODEL = "anthropic/claude-sonnet-5";

/** True when the chat LLM is configured (an OpenRouter key is present). */
export function chatLlmEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return Boolean(env.OPENROUTER_API_KEY);
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
  id?: string;
  choices?: Array<{ delta?: { content?: string | null } }>;
  /** The final chunk's accounting, present because the request asks for it. */
  usage?: { total_tokens?: number; cost?: number };
  error?: { message?: string };
}

/** What one streamed completion cost, as the provider reported it at the end. */
export interface ChatUsage {
  readonly totalTokens: number;
  /** USD as streamed; null when the provider sent no figure. */
  readonly cost: number | null;
}

/** The accounting one stream fills in as it goes: the provider's generation id
 *  from the FIRST chunk that names it (so an aborted or failed stream can still
 *  be priced by reading the generation back), and the final chunk's usage. */
export interface ChatAccount {
  generationId: string | null;
  usage: ChatUsage | null;
}

export const newChatAccount = (): ChatAccount => ({ generationId: null, usage: null });

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function openRouterBaseUrl(): string {
  return process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1";
}

/**
 * Stream a chat completion from OpenRouter, yielding text deltas as they arrive.
 * `apiKey` is the credential resolved by the caller (a customer's BYO OpenRouter
 * key when connected, else the house key) - this function never picks a key, so
 * an invalid customer key surfaces the real OpenRouter error rather than falling
 * back to the house. Throws ChatStreamError when no key is passed or the call
 * fails; the caller surfaces that as an SSE `error` frame. `signal` aborts the
 * fetch (used for the client's Stop control). `account`, when given, is filled
 * in place with the generation id as soon as a chunk names it and with the
 * final chunk's usage, so the caller can price the turn however it ended.
 */
export async function* streamChat(
  messages: ChatMessage[],
  model: string,
  apiKey: string,
  signal?: AbortSignal,
  account?: ChatAccount,
): AsyncGenerator<string, void, unknown> {
  if (!apiKey) throw new ChatStreamError("no OpenRouter credential resolved");

  const res = await fetch(`${openRouterBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://github.com/useagenthq/useagent",
      "X-Title": "useAgent Chat",
    },
    body: JSON.stringify({ model, messages, stream: true, usage: { include: true } }),
    signal,
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new ChatStreamError(`openrouter ${res.status}: ${detail.slice(0, 200)}`);
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
          if (account && !account.generationId && typeof chunk.id === "string" && chunk.id) {
            account.generationId = chunk.id;
          }
          if (chunk.error) throw new ChatStreamError(`openrouter error: ${chunk.error.message}`);
          const delta = chunk.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) yield delta;
          if (chunk.usage && account) {
            account.usage = {
              totalTokens: finiteNumber(chunk.usage.total_tokens) ?? 0,
              cost: finiteNumber(chunk.usage.cost),
            };
          }
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

/**
 * The provider's settled charge for one generation in USD, read back after the
 * stream ends with the same key that made it. The record can lag the stream by
 * a moment, so it is asked for a few times; null when it never turns up or the
 * read fails, in which case the streamed figure stands.
 */
export async function fetchGenerationCost(generationId: string, apiKey: string): Promise<number | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await Bun.sleep(500);
    try {
      const res = await fetch(`${openRouterBaseUrl()}/generation?id=${encodeURIComponent(generationId)}`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { data?: { total_cost?: unknown } };
      return finiteNumber(body.data?.total_cost);
    } catch {
      // Retry; a settled figure is a refinement, never a requirement.
    }
  }
  return null;
}
