/**
 * One turn at a time per organisation for changes that must not interleave:
 * membership and ownership changes, and every step of an invitation's life.
 * Whoever holds the turn checks and writes; nothing else about that
 * organisation moves until the turn is released.
 */
// ponytail: process-local, which matches the documented one-backend deployment; a database lock if replicas ever appear.
const orgLocks = new Map<string, Promise<unknown>>();

export function withOrgLock<T>(orgId: string, work: () => Promise<T>): Promise<T> {
  const previous = orgLocks.get(orgId) ?? Promise.resolve();
  const run = previous.then(work, work);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  orgLocks.set(orgId, settled);
  void settled.then(() => {
    if (orgLocks.get(orgId) === settled) orgLocks.delete(orgId);
  });
  return run;
}
