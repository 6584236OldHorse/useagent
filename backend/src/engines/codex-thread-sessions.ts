// One Codex relay session per thread and sandbox, kept across runs so a
// follow-up turn reuses the runtime's live Codex session (and its app-server on
// this host) instead of starting a new one. Process-local like the relay itself:
// a backend restart forgets every session and the next turn starts cold. Caps
// bound the Codex app-servers this host keeps; a run beyond them gets a session
// of its own that closes with the run.

const MAX_SESSIONS = 40;
const MAX_SESSIONS_PER_USER = 4;
const IDLE_EVICTION_MS = 5 * 60_000;
let idleEvictionMs = IDLE_EVICTION_MS;

/** What a kept session owns; closing it ends the relay and both bridges. */
export interface CodexThreadSessionParts {
  readonly environmentId: string;
  close(): void;
}

export interface CodexThreadSession<P extends CodexThreadSessionParts = CodexThreadSessionParts> {
  readonly key: string;
  readonly userKey: string;
  readonly parts: P;
}

interface Entry {
  readonly session: CodexThreadSession;
  active: boolean;
  lastUsedAt: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const entries = new Map<string, Entry>();
let now = () => Date.now();

export function codexThreadSessionKey(scope: {
  readonly orgId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly sandboxId: string;
  readonly connectionId: string;
  readonly authEpoch: string;
}): string {
  return JSON.stringify([scope.orgId, scope.userId, scope.threadId, scope.sandboxId, scope.connectionId, scope.authEpoch]);
}

/** The kept session for `key`, now in use by one run; null when there is none or a run holds it. */
export function claimCodexThreadSession<P extends CodexThreadSessionParts>(key: string): CodexThreadSession<P> | null {
  const entry = entries.get(key);
  if (!entry || entry.active) return null;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
  entry.active = true;
  entry.lastUsedAt = now();
  return entry.session as CodexThreadSession<P>;
}

/** Keep `parts` as the session for `key`, in use by the calling run. Idle
 * sessions are evicted least recently used first to stay within the caps;
 * null when the caps leave no room, and the caller owns `parts` alone. */
export function keepCodexThreadSession<P extends CodexThreadSessionParts>(
  key: string,
  userKey: string,
  parts: P,
): CodexThreadSession<P> | null {
  const previous = entries.get(key);
  if (previous) evict(previous, "replaced");
  while (entries.size >= MAX_SESSIONS || userSessions(userKey) >= MAX_SESSIONS_PER_USER) {
    const victim = leastRecentlyUsedIdle(entries.size >= MAX_SESSIONS ? null : userKey);
    if (!victim) return null;
    evict(victim, "capacity");
  }
  const session: CodexThreadSession<P> = { key, userKey, parts };
  entries.set(key, { session, active: true, lastUsedAt: now(), idleTimer: null });
  logLive("kept");
  return session;
}

/** The run is done with the session; it is evicted once it has idled long enough. */
export function releaseCodexThreadSession(session: CodexThreadSession): void {
  const entry = entries.get(session.key);
  if (!entry || entry.session !== session) return;
  entry.active = false;
  entry.lastUsedAt = now();
  entry.idleTimer = setTimeout(() => evict(entry, "idle"), idleEvictionMs);
  entry.idleTimer.unref?.();
}

/** Close and forget the session for `key` (a run found it unusable). */
export function evictCodexThreadSession(key: string, reason: string): void {
  const entry = entries.get(key);
  if (entry) evict(entry, reason);
}

export function liveCodexThreadSessions(): number {
  return entries.size;
}

function evict(entry: Entry, reason: string): void {
  if (entries.get(entry.session.key) !== entry) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entries.delete(entry.session.key);
  try {
    entry.session.parts.close();
  } finally {
    logLive(`evicted (${reason})`);
  }
}

function userSessions(userKey: string): number {
  let count = 0;
  for (const entry of entries.values()) if (entry.session.userKey === userKey) count += 1;
  return count;
}

function leastRecentlyUsedIdle(userKey: string | null): Entry | null {
  let oldest: Entry | null = null;
  for (const entry of entries.values()) {
    if (entry.active || (userKey !== null && entry.session.userKey !== userKey)) continue;
    if (!oldest || entry.lastUsedAt < oldest.lastUsedAt) oldest = entry;
  }
  return oldest;
}

function logLive(change: string): void {
  console.log(`[codex-thread-sessions] ${change}; live=${entries.size}`);
}

export function resetCodexThreadSessionsForTest(options: { readonly clock?: () => number; readonly idleMs?: number } = {}): void {
  for (const entry of [...entries.values()]) evict(entry, "reset");
  now = options.clock ?? (() => Date.now());
  idleEvictionMs = options.idleMs ?? IDLE_EVICTION_MS;
}
