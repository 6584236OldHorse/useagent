// The run a sandbox is being resolved for, carried on the async context so a
// process that does not own runner links (the tool gateway) can mint a
// capability for the bridge to the process that does. Set by
// resolveRunSandbox; read when the remote directory hands out a link.

import { AsyncLocalStorage } from "node:async_hooks";

export interface RunnerBridgeContext {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly threadId: string;
}

const storage = new AsyncLocalStorage<RunnerBridgeContext>();

export function withRunnerBridgeContext<T>(context: RunnerBridgeContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}

export function currentRunnerBridgeContext(): RunnerBridgeContext | null {
  return storage.getStore() ?? null;
}
