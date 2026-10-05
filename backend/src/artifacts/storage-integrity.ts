import { artifactStorage } from "./storage";
import { awaitWithSignal } from "../util/abortable-operation";

export async function verifyStoredArtifactBytes(
  digest: string,
  sizeBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  const size = await awaitWithSignal(() => artifactStorage().size(digest), signal);
  if (size !== sizeBytes) throw new Error("artifact storage verification failed");
  const storedDigest = await awaitWithSignal(() => artifactStorage().sha256(digest), signal);
  signal?.throwIfAborted();
  if (storedDigest !== digest) throw new Error("artifact storage verification failed");
}

export async function ensureStoredArtifactBytes(
  digest: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await verifyStoredArtifactBytes(digest, bytes.byteLength, signal);
    return;
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  signal?.throwIfAborted();
  await awaitWithSignal(() => artifactStorage().put(digest, bytes), signal);
  signal?.throwIfAborted();
  await verifyStoredArtifactBytes(digest, bytes.byteLength, signal);
}
