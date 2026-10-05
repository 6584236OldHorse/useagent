import { Mux, type MuxHandlers, type MuxOptions } from "@useagent/runner-protocol";

/** Two muxes joined in memory, delivering in order and asynchronously. */
export function connectPair(planeHandlers: MuxHandlers = {}, runnerHandlers: MuxHandlers = {}, options: MuxOptions = {}) {
  let plane: Mux;
  let runner: Mux;
  const queue: Array<() => void> = [];
  let draining = false;
  const deliver = (fn: () => void) => {
    queue.push(fn);
    if (draining) return;
    draining = true;
    queueMicrotask(() => {
      while (queue.length > 0) queue.shift()!();
      draining = false;
    });
  };
  plane = new Mux("plane", { send: (m) => deliver(() => runner.receive(m)) }, planeHandlers, options);
  runner = new Mux("runner", { send: (m) => deliver(() => plane.receive(m)) }, runnerHandlers, options);
  return { plane, runner };
}

export async function settled(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
