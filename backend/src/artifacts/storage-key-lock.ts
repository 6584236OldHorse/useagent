import { sql } from "drizzle-orm";
import { db, type DbTx } from "../db/client";

const CONTENT_ADDRESS = /^[a-f0-9]{64}$/;

/** Serialize one content-addressed storage key across backend processes.
 *
 * Callers acquire at most one storage-key lock per transaction and acquire it
 * before any narrower publication-identity lock. The transaction owns both the
 * advisory lock and the metadata write/reference recheck, so no reserved session
 * connection waits on a second pooled connection. */
export async function lockArtifactStorageKey(
  tx: DbTx,
  storageKey: string,
): Promise<void> {
  if (!CONTENT_ADDRESS.test(storageKey)) throw new Error("invalid artifact storage key");
  // A lock held elsewhere for longer than this fails the publication instead
  // of holding the caller: the transaction aborts and nothing persists.
  await tx.execute(sql`select set_config('lock_timeout', '30s', true)`);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`artifact-storage:${storageKey}`}, 0))`,
  );
}

export async function withArtifactStorageKeyLock<T>(
  storageKey: string,
  action: (tx: DbTx) => Promise<T>,
  beforeLock?: (tx: DbTx) => Promise<void>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await beforeLock?.(tx);
    await lockArtifactStorageKey(tx, storageKey);
    return action(tx);
  });
}
