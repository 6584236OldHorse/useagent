import { getThreadSandboxForOrg, threadHasActiveRuns } from "../runs/repo";
import { withThreadLifecycleLock } from "../runs/thread-lifecycle-lock";
import { releaseRunSandbox } from "../runs/sandbox-release";
import { resolveSandboxBindingForSandbox } from "../sandboxes/binding";
import { forgetLiveThreadSandbox, threadSandboxWatched } from "../engines/sandbox-runtime";
import { idleRetainedSandboxes, retainedSandboxReuseMs } from "./lease-repo";

// A settled thread keeps its sandbox for a fast follow-up, and an idle sandbox
// still bills. Providers that can pause on demand get paused a couple of minutes
// after the thread's last turn (the next turn resumes it in about a second).
// Every deployment sandbox idle past SANDBOX_AUTO_DELETE_MIN is deleted through
// the explicit release path, so leases and thread bindings stay consistent.

const PAUSE_AFTER_MS = 2 * 60_000;
const SWEEP_INTERVAL_MS = 30_000;
const DELETE_INTERVAL_MS = 10 * 60_000;
const DELETES_PER_SWEEP = 20;
const DELETE_RETRY_MS = 60 * 60_000;
// ponytail: one page of candidates per sweep; page by cursor if a deployment ever idles more threads at once.
const CANDIDATE_LIMIT = 500;

/** Sandboxes this process already paused while they stay idle; pruned every sweep. */
let paused = new Set<string>();
/** When a sandbox whose delete failed may be tried again. */
const deleteRetryAt = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;
let lastDeleteAt = 0;

/** A sandbox idle longer than its own lifetime already paused itself. */
function sandboxLifetimeMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const minutes = Number(env.SANDBOX_AUTO_STOP_MIN ?? 30);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 30) * 60_000;
}

const pauseDependencies = {
  candidates: idleRetainedSandboxes,
  binding: resolveSandboxBindingForSandbox,
  watched: threadSandboxWatched,
  withLock: withThreadLifecycleLock,
};

export async function pauseIdleSandboxes(deps = pauseDependencies): Promise<number> {
  const candidates = await deps.candidates({
    idleForMs: PAUSE_AFTER_MS,
    idleAtMostMs: sandboxLifetimeMs(),
    limit: CANDIDATE_LIMIT,
  });
  // A sandbox that left the idle window (a new turn ran on it) is paused again after that turn.
  paused = new Set(candidates.map((c) => c.sandboxId).filter((id) => paused.has(id)));
  let count = 0;
  for (const candidate of candidates) {
    if (paused.has(candidate.sandboxId) || deps.watched(candidate.threadId)) continue;
    // Marked first so a failing provider is not called again every sweep.
    paused.add(candidate.sandboxId);
    try {
      const { provider } = await deps.binding(candidate.sandboxId);
      if (!provider.pause) continue;
      const pause = provider.pause.bind(provider);
      // The lock holds back a new turn on this thread until the pause is done;
      // the turn then resumes the box instead of racing it.
      count += await deps.withLock(candidate.orgId, candidate.threadId, async (tx) => {
        if (await threadHasActiveRuns(candidate.orgId, candidate.threadId, tx)) return 0;
        if (await getThreadSandboxForOrg(candidate.orgId, candidate.threadId, tx) !== candidate.sandboxId) return 0;
        await pause(candidate.sandboxId);
        forgetLiveThreadSandbox(candidate.threadId, candidate.sandboxId);
        return 1;
      });
    } catch (error) {
      console.warn(`[fleet] pausing idle sandbox ${candidate.sandboxId} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return count;
}

export async function deleteExpiredSandboxes(
  deps = { candidates: idleRetainedSandboxes, release: releaseRunSandbox },
): Promise<number> {
  const candidates = await deps.candidates({ idleForMs: retainedSandboxReuseMs(), limit: CANDIDATE_LIMIT });
  const now = Date.now();
  let attempts = 0;
  let count = 0;
  for (const candidate of candidates) {
    if (attempts >= DELETES_PER_SWEEP) break;
    if ((deleteRetryAt.get(candidate.sandboxId) ?? 0) > now) continue;
    attempts += 1;
    const result = await deps.release(candidate.orgId, candidate.runId).catch((error: unknown) => {
      console.warn(`[fleet] deleting expired sandbox ${candidate.sandboxId} failed:`, error instanceof Error ? error.message : error);
      return null;
    });
    if (result?.ok) {
      deleteRetryAt.delete(candidate.sandboxId);
      if (result.released) count += 1;
    } else {
      if (result) console.warn(`[fleet] expired sandbox ${candidate.sandboxId} not deleted: ${result.reason}`);
      deleteRetryAt.set(candidate.sandboxId, now + DELETE_RETRY_MS);
    }
  }
  return count;
}

/** Start the background sweep (idempotent, single-flight, unref'd). */
export function startIdleSandboxSweep(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void (async () => {
      await pauseIdleSandboxes();
      if (Date.now() - lastDeleteAt < DELETE_INTERVAL_MS) return;
      lastDeleteAt = Date.now();
      await deleteExpiredSandboxes();
    })()
      .catch((error) => console.warn("[fleet] idle sandbox sweep failed:", error instanceof Error ? error.message : error))
      .finally(() => {
        sweeping = false;
      });
  }, SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopIdleSandboxSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
  sweeping = false;
}
