import type { SandboxExecuteResult, SandboxHandle } from "./provider";

// Warm-turn preflight: checks a turn will run anyway, issued together as soon
// as a retained sandbox is known instead of one after another. Each result is
// taken at most once, by the step that would have produced it (a command by its
// exact text); whatever a turn did not take is dropped when its preparation ends.
const prefetched = new WeakMap<object, Map<string, Promise<unknown>>>();

type CommandSandbox = { readonly process: Pick<SandboxHandle["process"], "executeCommand"> };

export function prefetchSandboxResult<T>(sandbox: object, key: string, start: () => Promise<T>): void {
  let results = prefetched.get(sandbox);
  if (!results) prefetched.set(sandbox, results = new Map());
  if (results.has(key)) return;
  const result = start();
  // The step that takes it sees a failure; one nobody takes is just dropped.
  result.catch(() => {});
  results.set(key, result);
}

/** The prefetched result under `key`, handed out once. */
export function takePrefetchedSandboxResult<T>(sandbox: object, key: string): Promise<T> | null {
  const results = prefetched.get(sandbox);
  const result = results?.get(key) ?? null;
  results?.delete(key);
  return result as Promise<T> | null;
}

export function dropPrefetchedSandboxResults(sandbox: object): void {
  prefetched.delete(sandbox);
}

export function prefetchSandboxCommand(
  sandbox: CommandSandbox,
  command: string,
  timeoutSeconds: number,
): void {
  prefetchSandboxResult(sandbox, command, () =>
    sandbox.process.executeCommand(command, undefined, undefined, timeoutSeconds));
}

/** This exact command's prefetched result, or a run of it now. */
export function executeSandboxCommandOnce(
  sandbox: CommandSandbox,
  command: string,
  timeoutSeconds: number,
): Promise<SandboxExecuteResult> {
  return takePrefetchedSandboxResult<SandboxExecuteResult>(sandbox, command) ??
    sandbox.process.executeCommand(command, undefined, undefined, timeoutSeconds);
}
