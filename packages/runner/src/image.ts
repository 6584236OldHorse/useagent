// The native image on this machine: pulled once by reference, verified by the
// digest the control plane names, kept until the plane names another.

import type { ImageRef } from "@useagent/runner-protocol";
import type { LocalBackend } from "./backends/types";

export interface ImageProgress {
  (progress: number, detail: string): void;
}

/** Make `image` present at its digest. Resolves with the digest now on disk. */
export async function ensureImage(backend: LocalBackend, image: ImageRef, onProgress?: ImageProgress): Promise<string> {
  const present = await backend.imageDigest(image.ref);
  if (present === image.digest) return present;
  let lines = 0;
  await backend.pullImage(image.ref, (line) => {
    lines += 1;
    // Pull output has no total; the bar creeps toward, never reaches, done.
    onProgress?.(Math.min(0.95, 1 - 1 / (1 + lines / 25)), line);
  });
  const pulled = await backend.imageDigest(image.ref);
  if (pulled !== image.digest) {
    throw new Error(`pulled ${image.ref} at ${pulled ?? "no digest"}, the control plane expects ${image.digest}`);
  }
  onProgress?.(1, "image ready");
  return pulled;
}
