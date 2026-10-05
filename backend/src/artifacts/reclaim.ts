import { db, type Executor } from "../db/client";
import { artifacts, githubChangeSets, userUploads } from "../db/schema";
import {
  artifactStorage,
  type ArtifactReclaimResult,
  LocalArtifactStorage,
} from "./storage";
import { sql } from "drizzle-orm";
import { withArtifactStorageKeyLock } from "./storage-key-lock";

export async function listReferencedArtifactStorageKeys(): Promise<Set<string>> {
  const [artifactRows, uploadRows, githubRows] = await Promise.all([
    db.select({
      storageKey: artifacts.storageKey,
      previewStorageKey: artifacts.previewStorageKey,
    }).from(artifacts),
    db.select({ storageKey: userUploads.storageKey }).from(userUploads),
    db.select({ storageKey: githubChangeSets.payloadStorageKey }).from(githubChangeSets),
  ]);
  return new Set([
    ...artifactRows.map((row) => row.storageKey),
    ...artifactRows.flatMap((row) => row.previewStorageKey ? [row.previewStorageKey] : []),
    ...uploadRows.map((row) => row.storageKey),
    ...githubRows.map((row) => row.storageKey),
  ]);
}

export async function artifactStorageKeyIsReferenced(
  storageKey: string,
  exec: Executor = db,
): Promise<boolean> {
  const [row] = await exec.execute(sql`
    select 1 as found
    where exists (
      select 1 from ${artifacts}
      where ${artifacts.storageKey} = ${storageKey}
         or ${artifacts.previewStorageKey} = ${storageKey}
    ) or exists (
      select 1 from ${userUploads}
      where ${userUploads.storageKey} = ${storageKey}
    ) or exists (
      select 1 from ${githubChangeSets}
      where ${githubChangeSets.payloadStorageKey} = ${storageKey}
    )
    limit 1
  `);
  return Boolean(row);
}

export async function reclaimUnreferencedLocalArtifacts(input: {
  readonly dryRun?: boolean;
  readonly minAgeMs?: number;
  readonly now?: Date;
} = {}): Promise<ArtifactReclaimResult> {
  const storage = artifactStorage();
  if (!(storage instanceof LocalArtifactStorage)) {
    throw new Error("artifact orphan reclamation is only supported by local artifact storage");
  }
  const referencedKeys = await listReferencedArtifactStorageKeys();
  return storage.reclaimUnreferenced({
    ...input,
    referencedKeys,
    isReferenced: artifactStorageKeyIsReferenced,
    withStorageKeyLock: (storageKey, action) =>
      withArtifactStorageKeyLock(storageKey, (tx) =>
        action(() => artifactStorageKeyIsReferenced(storageKey, tx))),
  });
}
