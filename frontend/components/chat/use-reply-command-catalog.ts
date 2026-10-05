"use client";

import { useEffect, useMemo, useState } from "react";
import {
  type CanonicalCommandView,
  type CommandCatalogState,
  intentCommands, resolveCommandCatalog,
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
 *   - the session command catalog the runtime engines record after their session starts and
 *     once each turn settles, fetched from GET /api/commands with the thread and session: a
 *     response carrying a `revision` is that session's own catalog, refetched when the session
 *     changes and when the thread settles.
 * With neither, the same GET (keyed by engine alone) primes the picker with the org's latest
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
  const durable = useMemo(
    () => selectSessionCommandCatalog([...runsById.values()], engineSessionId),
    [runsById, engineSessionId],
  );
  const hasDurable = durable !== null;
  const [fetchState, setFetchState] = useState<{
    phase: "loading" | "done" | "error";
    commands: CanonicalCommandView[];
    revision: number | null;
  }>({
    phase: "loading",
    commands: [],
    revision: null,
  });
  useEffect(() => {
    if (hasDurable) return; // the canonical session catalog wins; no fetch needed
    let cancelled = false;
    // Clear-on-change: reset immediately so a prior engine's commands never linger while loading.
    setFetchState({ phase: "loading", commands: [], revision: null });
    void (async () => {
      const fail = () => !cancelled && setFetchState({ phase: "error", commands: [], revision: null });
      try {
        const session = engineSessionId
          ? `&thread=${encodeURIComponent(threadId)}&session=${encodeURIComponent(engineSessionId)}`
          : "";
        const res = await backendFetch(`/api/commands?engine=${encodeURIComponent(engine)}${session}`);
        if (!res.ok) return fail();
        const body = (await res.json()) as {
          commands?: { name?: string; description?: string; input?: string }[];
          revision?: number | null;
        };
        if (cancelled) return;
        const list = body.commands ?? [];
        if (!Array.isArray(list)) return fail();
        setFetchState({
          phase: "done",
          commands: list
            .filter((c): c is { name: string; description?: string; input?: string } => !!c.name)
            .map((c) => ({
              name: c.name,
              description: c.description ?? null,
              input: typeof c.input === "string" ? c.input : null,
            })),
          revision: typeof body.revision === "number" ? body.revision : null,
        });
      } catch {
        fail();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [engine, hasDurable, threadId, engineSessionId, live]);
  const catalogState = useMemo(
    () => resolveCommandCatalog(durable?.commands ?? null, fetchState, engine),
    [durable, fetchState, engine],
  );
  // Typed intents and the Compact action: the session's own catalog only. A primed (stale)
  // catalog still lists in the picker through `catalogState`, and a pick sends the text verbatim.
  const commands: SlashCommand[] = useMemo(
    () => intentCommands(catalogState).map((c) => ({ name: c.name, description: c.description ?? null })),
    [catalogState],
  );
  const revision = durable?.revision ?? (fetchState.phase === "done" ? fetchState.revision : null);
  return { catalogState, commands, revision };
}
