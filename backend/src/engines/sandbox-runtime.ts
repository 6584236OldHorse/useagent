import type { SandboxHandle } from "../sandboxes/provider";

/**
 * Process-local handles for sandboxes already resolved by this backend.
 *
 * Postgres remains the durable thread-to-sandbox source of truth. This registry
 * only avoids another Daytona control-plane lookup while the same backend still
 * owns a live SDK object. A restart naturally empties it and falls back to the
 * durable mapping.
 */
const liveThreadSandboxes = new Map<string, SandboxHandle>();

/**
 * Handles a full provider lookup verified in this process, by sandbox id, for
 * callers that hold no thread lease (the tool gateway runs in its own process).
 * Nothing tells that process when a sandbox pauses or goes away, so an entry is
 * trusted for one minute only.
 */
const VERIFIED_SANDBOX_TTL_MS = 60_000;
const verifiedSandboxes = new Map<string, { readonly sandbox: SandboxHandle; readonly at: number }>();

export function getLiveThreadSandbox(threadId: string): SandboxHandle | null {
  return liveThreadSandboxes.get(threadId) ?? null;
}

export function rememberLiveThreadSandbox(threadId: string, sandbox: SandboxHandle): void {
  liveThreadSandboxes.set(threadId, sandbox);
}

/**
 * Remove a handle only when it still points at the sandbox being cleaned up.
 * The optional id prevents an older run's finally block from evicting a newer
 * sandbox that has already replaced it for the same thread.
 */
export function forgetLiveThreadSandbox(threadId: string, sandboxId?: string): void {
  const live = liveThreadSandboxes.get(threadId);
  if (sandboxId) verifiedSandboxes.delete(sandboxId);
  if (sandboxId && live?.id !== sandboxId) return;
  liveThreadSandboxes.delete(threadId);
  if (live) verifiedSandboxes.delete(live.id);
}

/** A handle this process already verified for `sandboxId`: a thread's leased one, else a lookup from the last minute. */
export function getLiveSandbox(sandboxId: string): SandboxHandle | null {
  const leased = liveThreadSandboxes.values().find((sandbox) => sandbox.id === sandboxId);
  if (leased) return leased;
  const verified = verifiedSandboxes.get(sandboxId);
  if (verified && Date.now() - verified.at < VERIFIED_SANDBOX_TTL_MS) return verified.sandbox;
  verifiedSandboxes.delete(sandboxId);
  return null;
}

/** Record a handle a full provider lookup just verified; expired entries go on the way. */
export function rememberVerifiedSandbox(sandbox: SandboxHandle): void {
  const now = Date.now();
  for (const [id, entry] of verifiedSandboxes) {
    if (now - entry.at >= VERIFIED_SANDBOX_TTL_MS) verifiedSandboxes.delete(id);
  }
  verifiedSandboxes.set(sandbox.id, { sandbox, at: now });
}

/** Drop a handle that failed, wherever this process holds it; true when it was held. */
export function forgetLiveSandbox(sandbox: SandboxHandle): boolean {
  let held = false;
  for (const [threadId, live] of liveThreadSandboxes) {
    if (live !== sandbox) continue;
    liveThreadSandboxes.delete(threadId);
    held = true;
  }
  if (verifiedSandboxes.get(sandbox.id)?.sandbox === sandbox) {
    verifiedSandboxes.delete(sandbox.id);
    held = true;
  }
  return held;
}

/** Open terminal and desktop connections per thread: an idle sandbox someone is looking at is not paused. */
const threadViewers = new Map<string, number>();

/** Count one open viewer of a thread's sandbox; the returned release is safe to call twice. */
export function watchThreadSandbox(threadId: string): () => void {
  threadViewers.set(threadId, (threadViewers.get(threadId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (threadViewers.get(threadId) ?? 1) - 1;
    if (left > 0) threadViewers.set(threadId, left);
    else threadViewers.delete(threadId);
  };
}

export function threadSandboxWatched(threadId: string): boolean {
  return threadViewers.has(threadId);
}
