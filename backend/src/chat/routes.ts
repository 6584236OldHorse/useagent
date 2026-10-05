import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { isMemoryScope, type MemoryScope } from "../memory/scope";
import { resolveChatProviderCredential } from "../provider-gateway/credentials";
import {
  buildResourceAccessSnapshot,
  formatResourceAccessContext,
} from "../resources/access-snapshot";
import { captureChatExchange } from "./capture";
import { chatModelCatalog } from "./models";
import { CHAT_SYSTEM_PROMPT } from "./prompt";
import { retrieveChatContext } from "./retrieve";
import { chatModel, newChatAccount, streamChat, type ChatMessage } from "./stream";
import { chargeChatTurn, noteChatGeneration } from "./turn";
import {
  assertSpendAllowance,
  discardSpendCharge,
  openSpendCharge,
  SpendAllowanceExceededError,
} from "../runs/spend";
import { errorMessage } from "../util/error-message";

/**
 * Lightweight Chat API (#122) - mounted at /api/chat. A NO-SANDBOX conversational
 * surface: talk to the model directly (instant, cheap), augmented with READ-ONLY
 * retrieval (org knowledge + published wiki + team memory). Distinct from the
 * Agent surface (/api/runs), which spins Daytona sandboxes.
 *
 * Tenancy is server-resolved by the universal auth adapter (index.ts); the
 * per-router `orgScope` below is house-style defense-in-depth (idempotent).
 */
export const chatRoutes = new Hono<AppEnv>();

chatRoutes.use("*", orgScope);

const MESSAGE_ROLES = new Set(["user", "assistant"]);

/** Validate the request's `messages` into a typed list, or null on any malformed
 *  entry / a history with no user turn. */
function parseMessages(raw: unknown): ChatMessage[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: ChatMessage[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const rec = entry as Record<string, unknown>;
    const role = rec.role;
    const content = rec.content;
    if (typeof role !== "string" || !MESSAGE_ROLES.has(role) || typeof content !== "string") {
      return null;
    }
    out.push({ role: role as ChatMessage["role"], content });
  }
  return out.some((m) => m.role === "user") ? out : null;
}

// GET /api/chat/models - the served model catalog + current default. Powers the
// Chat page's real model picker (honest: the UI renders exactly what the key
// serves). Harmless when the LLM is unconfigured; the list is informational.
chatRoutes.get("/models", (c) => c.json(chatModelCatalog()));

// POST /api/chat - SSE. Body: { messages: [{role, content}], model?, memoryScope? }.
// Emits `event: context` (citations) once, then a burst of `event: delta` text
// tokens, then `event: done`. A failure surfaces as `event: error`. NO sandbox.
//
// Built as a raw ReadableStream (not hono streamSSE) so we own every header -
// `no-transform` + `X-Accel-Buffering: no` stop proxies buffering the stream
// (the same SSE-hygiene the runs `/events` route relies on).
chatRoutes.post("/", async (c) => {
  let body: { messages?: unknown; model?: unknown; memoryScope?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const messages = parseMessages(body.messages);
  if (!messages) {
    return c.json({ error: "`messages` must be a non-empty array of {role, content}" }, 400);
  }

  const model =
    typeof body.model === "string" && body.model.trim() ? body.model.trim() : chatModel();
  if (!chatModelCatalog().models.some((candidate) => candidate.value === model)) {
    return c.json({ error: "model_not_allowed" }, 400);
  }
  const memoryScope: MemoryScope = isMemoryScope(body.memoryScope) ? body.memoryScope : "org";

  const orgId = c.get("orgId");
  // The identity orgScope verified, carried through rather than resolved a
  // second time (a failed second lookup must never turn a member into nobody
  // and hand them an uncharged, house-keyed answer). The dev fallback is
  // anonymous here: no member credential, no allowance, no charge, and
  // personal-scope retrieval fails closed. Anything else fails closed.
  const identitySource = c.get("identitySource");
  if (identitySource !== "session" && identitySource !== "dev") {
    return c.json({ error: "unauthorized" }, 401);
  }
  const userId = identitySource === "session" ? c.get("userId") : null;

  // Resolve the OpenRouter credential BYOK-first: a customer's connected key
  // wins over the house key, so their own quota is spent (and an invalid
  // customer key surfaces its real error rather than re-billing the house).
  const resolved = await resolveChatProviderCredential({ orgId, userId });
  if (!resolved) {
    return c.json({ error: "chat is not configured (no OpenRouter credential)" }, 503);
  }
  // The same allowance every run ingress enforces, before any model call: a
  // member at the cap is refused here too, and the turn below is charged.
  try {
    await assertSpendAllowance(orgId, userId);
  } catch (error) {
    if (error instanceof SpendAllowanceExceededError) return c.json(error.body, 402);
    throw error;
  }
  // The member's charge is opened BEFORE any model call, so the intent to
  // charge is durable from the start: a completion that fails to write leaves
  // a pending entry the sweep settles, never a lost figure. A ledger that
  // cannot take the intent takes no turn.
  const charge = userId ? { key: `chat:${crypto.randomUUID()}`, orgId, userId } : null;
  if (charge) {
    try {
      await openSpendCharge(charge);
    } catch (error) {
      console.error(`[spend] could not open chat charge ${charge.key}:`, errorMessage(error));
      return c.json(
        { error: "ledger_unavailable", message: "The spend ledger is unavailable. Try again in a moment." },
        503,
      );
    }
  }
  console.info(`[chat] org ${orgId} served by ${resolved.source}`);

  // Retrieve against the latest user message; the surface is stateless so a
  // synthetic per-org session id stands in for the memory provenance threadId.
  const query = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const threadId = `chat:${orgId}`;

  const encoder = new TextEncoder();
  const signal = c.req.raw.signal;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (frame: string): void => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          /* controller already closed (client gone) */
        }
      };
      const sendEvent = (event: string, data: unknown): void =>
        send(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

      // Prime headers/first bytes, then heartbeat idle streams.
      send(": open\n\n");
      const heartbeat = setInterval(() => send(": ping\n\n"), 25_000);
      heartbeat.unref?.();

      const cleanup = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        signal.removeEventListener("abort", cleanup);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      if (signal.aborted) {
        // Gone before any model call: the open charge is dropped, not left pending.
        if (charge) void discardSpendCharge(charge.key).catch((error) => {
          console.error(`[spend] could not drop chat charge ${charge.key}:`, errorMessage(error));
        });
        return cleanup();
      }
      signal.addEventListener("abort", cleanup);
      const account = newChatAccount();
      let completed = false;

      void (async () => {
        try {
          // Read-only retrieval first (best-effort, never throws) so the UI can
          // show honest Sources before the answer streams.
          const [context, resourceSnapshot] = await Promise.all([
            retrieveChatContext({ orgId, userId, query, memoryScope, threadId }),
            userId
              ? buildResourceAccessSnapshot(
                  {
                    orgId,
                    userId,
                    runId: threadId,
                    resources: [],
                    repos: [],
                  },
                  undefined,
                  { inlineLimit: 500, exactInventoryTool: null },
                )
              : Promise.resolve(null),
          ]);
          if (closed) return;
          sendEvent("context", { citations: context.citations });

          const system = [
            CHAT_SYSTEM_PROMPT,
            resourceSnapshot ? formatResourceAccessContext(resourceSnapshot) : "",
            context.block,
          ].filter(Boolean).join("\n\n");
          const llmMessages: ChatMessage[] = [{ role: "system", content: system }, ...messages];
          let answer = "";
          let generationNoted = false;
          for await (const delta of streamChat(llmMessages, model, resolved.value, signal, account)) {
            if (closed) return;
            if (charge && !generationNoted && account.generationId) {
              // Noted as soon as the stream names it (retried, and remembered
              // for the sweep if it will not land), so a charge this process
              // never completes can still be priced from the provider's record.
              generationNoted = true;
              void noteChatGeneration(charge, account.generationId);
            }
            answer += delta;
            sendEvent("delta", { delta });
          }
          completed = true;
          if (!closed) {
            sendEvent("done", {});
            // Governed capture parity (item 7): a COMPLETED exchange (never an
            // aborted stream) enqueues through the same outbox + salience gate
            // as runs, marked with the chat origin. Best-effort by contract —
            // captureChatExchange never throws into the stream.
            void captureChatExchange({ orgId, userId, memoryScope, prompt: query, summary: answer, model });
          }
        } catch {
          if (!closed) sendEvent("error", { error: "chat request failed" });
        } finally {
          // Charged however the stream ended; the response never waits on it.
          if (charge) void chargeChatTurn({ ...charge, account, credential: resolved, completed });
          cleanup();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

export default chatRoutes;
