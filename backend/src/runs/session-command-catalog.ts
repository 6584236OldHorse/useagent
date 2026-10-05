import type { CanonicalCommand } from "@useagent/agent-harness/canonical";
import { and, eq } from "drizzle-orm";
import { client, db } from "../db/client";
import { sessionCommandCatalogs } from "../db/schema";

// ---------------------------------------------------------------------------
// The session command catalog table: what a native session advertises, keyed
// by (thread, engine, session) with a revision that rises when the list
// changes. The runtime adapter writes it best effort after session.started
// and once the turn settles; command-catalog.ts reads it to authorize a typed
// command. The write is one upsert inside a short transaction on its own pool
// connection, bounded by a server-side statement_timeout: a stalled write ends
// there with nothing recorded, and nothing ever cancels it from the client
// (the driver's cancel() discards its cancel-connection promise, so a failing
// cancel connection would be an unhandled rejection). No retry, no sequence
// number, nothing finalization waits on.
// ---------------------------------------------------------------------------

export const SESSION_COMMAND_CATALOG_WRITE_TIMEOUT_MS = 5_000;

export interface SessionCommandCatalogRow {
  readonly threadId: string;
  readonly provider: string;
  readonly nativeSessionId: string;
  readonly commands: readonly CanonicalCommand[];
}

/** Record the catalog: a new session's row at revision 1, or the same row with
 *  its revision raised when the list changed. An unchanged list writes nothing,
 *  so the revision a composer already holds stays valid across quiet turns.
 *  Resolves once the transaction committed; rejects when the statement failed or
 *  hit `timeoutMs` (SQLSTATE 57014), in which case nothing was recorded. */
export async function recordSessionCommandCatalog(
  row: SessionCommandCatalogRow,
  timeoutMs: number = SESSION_COMMAND_CATALOG_WRITE_TIMEOUT_MS,
): Promise<void> {
  await client.begin(async (tx) => {
    await tx`select set_config('statement_timeout', ${`${Math.max(1, Math.floor(timeoutMs))}ms`}, true)`;
    await tx`
      insert into session_command_catalogs (thread_id, provider, native_session_id, revision, commands)
      values (${row.threadId}, ${row.provider}, ${row.nativeSessionId}, 1, ${JSON.stringify(row.commands)}::jsonb)
      on conflict (thread_id, provider, native_session_id) do update
        set revision = session_command_catalogs.revision + 1,
            commands = excluded.commands,
            updated_at = now()
        where session_command_catalogs.commands is distinct from excluded.commands`;
  });
}

/** The recorded catalog for one session, with the revision a command intent
 *  must match; null when the session has no row (a Pi session advertises
 *  through the canonical stream instead, see command-catalog.ts). */
export async function readSessionCommandCatalogRow(
  threadId: string,
  provider: string,
  nativeSessionId: string,
): Promise<{ commands: readonly CanonicalCommand[]; revision: number } | null> {
  const [row] = await db
    .select({ commands: sessionCommandCatalogs.commands, revision: sessionCommandCatalogs.revision })
    .from(sessionCommandCatalogs)
    .where(and(
      eq(sessionCommandCatalogs.threadId, threadId),
      eq(sessionCommandCatalogs.provider, provider),
      eq(sessionCommandCatalogs.nativeSessionId, nativeSessionId),
    ))
    .limit(1);
  return row ?? null;
}
