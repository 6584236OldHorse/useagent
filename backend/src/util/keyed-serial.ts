/** Run tasks for the same key one after another, tasks for different keys freely.
 *  In-process only: one backend per database is the deployment invariant, so this
 *  is enough to order commits and publishes per thread. */
export function keyedSerial(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return (key, task) => {
    const previous = tails.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, settled);
    void settled.then(() => {
      if (tails.get(key) === settled) tails.delete(key);
    });
    return run;
  };
}
