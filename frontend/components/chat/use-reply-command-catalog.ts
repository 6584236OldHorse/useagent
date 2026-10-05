"use client";

import { useEffect, useMemo, useState } from "react";
import {
  type CanonicalCommandView,
  type CommandCatalogState,
  intentCommands, resolveCommandCatalog,
  type SessionCatalogAnswer,
  selectComposerSessionCatalog,
  selectSessionCommandCatalog,
} from "@/components/chat/canonical-timeline";
import type { SlashCommand } from "@/components/chat/slash-command";
import type { ThreadSnapshot } from "@/components/chat/thread-store";
import { type EngineId, normalizeEngine } from "@/components/chat/types";
import { backendFetch } from "@/lib/backend-fetch";

/**
 * Slash-command catalog for the reply composer's "/" autocomplete - the SELECTED engine's
 * real native commands, capability-driven (no provider-name gate), SESSION-SCOPED to the
 * current native session so a historical or other-session snapshot can NEVER mask the active
 * session. Two durable sources, one state:
 *   - the canonical stream's per-session `commands.updated` (Pi advertises through its bridge
 *     frames), read from the thread snapshot with its delivery sequence as the revision;
 *   - the answer of GET /api/commands for the thread and the current session, which is the
 *     backend reader's own answer (the session command catalog the runtime engines record
 *     after their session starts and once each turn settles, else the canonical stream). It
 *     names the session it belongs to and carries a `revision` when it is the session's own
 *     catalog; fetched when the session changes, when the thread settles and when the canonical
 *     catalog moves, and it wins over the canonical catalog for the current session
 *     (`selectComposerSessionCatalog`), so the composer always sends the revision the backend
 *     requires.
 * With neither, the same answer (keyed by engine alone) primes the picker with the org's latest
 * snapshot for display only until the session advertises. `resolveCommandCatalog` folds both
 * into one honest state (loading / unavailable / error / ready[+stale]); `revision` is the
 * snapshot a native-command intent is sent with, so the backend's fail-closed authorization
 * rejects a stale catalog.
 *
 * The results are memoized so the memoized Conversation sees stable prop identities between
 * catalog changes (a re-render here must not re-render the whole timeline).
 */
export function useReplyCommandCatalog(
  runsById: ThreadSnapshot["byId"],
  engineSessionId: string | null,
  rawEngine: EngineId,
  threadId: string,
  live: boolean,
): { catalogState: CommandCatalogState; commands: SlashCommand[]; revision: number | null } {
  const engine = normalizeEngine(rawEngine);
  const canonical = useMemo(
    () => selectSessionCommandCatalog([...runsById.values()], engineSessionId),
    [runsById, engineSessionId],
  );
  const canonicalRevision = canonical?.revision ?? null;
  const [fetchState, setFetchState] = useState<{
    phase: "loading" | "done" | "error";
    answer: SessionCatalogAnswer | null;
  }>({ phase: "loading", answer: null });
  useEffect(() => {
    let cancelled = false;
    // Clear-on-change: reset immediately so a prior engine's or session's answer never lingers.
    setFetchState({ phase: "loading", answer: null });
    void (async () => {
      const fail = () => !cancelled && setFetchState({ phase: "error", answer: null });
      try {
        const session = engineSessionId
          ? `&thread=${encodeURIComponent(threadId)}&session=${encodeURIComponent(engineSessionId)}`
          : "";
        const res = await backendFetch(`/api/commands?engine=${encodeURIComponent(engine)}${session}`);
        if (!res.ok) return fail();
        const body = (await res.json()) as {
          commands?: { name?: string; description?: string; input?: string }[];
          revision?: number | null;
          session?: string | null;
        };
        if (cancelled) return;
        const list = body.commands ?? [];
        if (!Array.isArray(list)) return fail();
        const commands: CanonicalCommandView[] = list
          .filter((c): c is { name: string; description?: string; input?: string } => !!c.name)
          .map((c) => ({
            name: c.name,
            description: c.description ?? null,
            input: typeof c.input === "string" ? c.input : null,
          }));
        setFetchState({
          phase: "done",
          answer: {
            commands,
            revision: typeof body.revision === "number" ? body.revision : null,
            session: typeof body.session === "string" ? body.session : null,
          },
        });
      } catch {
        fail();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engine, threadId, engineSessionId, live, canonicalRevision]);
  const session = useMemo(
    () => selectComposerSessionCatalog(canonical, fetchState.answer, engineSessionId),
    [canonical, fetchState.answer, engineSessionId],
  );
  const catalogState = useMemo(
    () => resolveCommandCatalog(
      session?.commands ?? null,
      { phase: fetchState.phase, commands: fetchState.answer?.commands ?? [] },
      engine,
    ),
    [session, fetchState, engine],
  );
  // Typed intents and the Compact action: the session's own catalog only. A primed (stale)
  // catalog still lists in the picker through `catalogState`, and a pick sends the text verbatim.
  const commands: SlashCommand[] = useMemo(
    () => intentCommands(catalogState).map((c) => ({ name: c.name, description: c.description ?? null })),
    [catalogState],
  );
  return { catalogState, commands, revision: session?.revision ?? null };
}
