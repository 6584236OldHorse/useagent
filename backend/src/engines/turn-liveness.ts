import type { SandboxHandle } from "../sandboxes/provider";
import { runtimeEnvironmentHealthy } from "./runtime-environment";

// A turn may run as long as its work needs; nothing here is a time limit. The
// turn fails only when its sandbox is gone: the runtime stream has gone silent
// (no frame, no pong) AND the sandbox has failed several health probes in a row.

/** How often a running turn pushes out the sandbox's own lifetime clock (providers with an absolute deadline). */
const SANDBOX_KEEPALIVE_MS = 5 * 60_000;
const PROBE_INTERVAL_MS = 30_000;
const STREAM_SILENCE_MS = 60_000;
const PROBE_FAILURES_BEFORE_DEAD = 4;
/** A probe that never returns (a frozen VM) counts as a failed one. */
const PROBE_TIMEOUT_MS = 20_000;
/** Pings keep the runtime stream answering through quiet stretches, so silence means a dead link. */
export const RUNTIME_STREAM_PING_MS = 20_000;

export const SANDBOX_STOPPED_RESPONDING = "The sandbox stopped responding";

export class SandboxUnresponsiveError extends Error {
  constructor() {
    super(SANDBOX_STOPPED_RESPONDING);
    this.name = "SandboxUnresponsiveError";
  }
}

export interface TurnLiveness {
  /** Aborted with SandboxUnresponsiveError once the sandbox is judged gone. */
  readonly signal: AbortSignal;
  /** The runtime stream delivered something: a frame or a pong. */
  heard(): void;
  dispose(): void;
}

type LivenessSandbox = Pick<SandboxHandle, "keepAlive"> & Parameters<typeof runtimeEnvironmentHealthy>[0];

async function sandboxAnswers(sandbox: LivenessSandbox): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([runtimeEnvironmentHealthy(sandbox), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export function watchTurnLiveness(
  sandbox: LivenessSandbox,
  options: {
    readonly probe?: () => Promise<boolean>;
    readonly intervalMs?: number;
    readonly silenceMs?: number;
    readonly failureLimit?: number;
  } = {},
): TurnLiveness {
  const probe = options.probe ?? (() => sandboxAnswers(sandbox));
  const silenceMs = options.silenceMs ?? STREAM_SILENCE_MS;
  const failureLimit = options.failureLimit ?? PROBE_FAILURES_BEFORE_DEAD;
  const controller = new AbortController();
  let lastHeard = Date.now();
  let failures = 0;
  let probing = false;

  // The first push happens now: a reused sandbox may have little lifetime left.
  const keepAlive = () => void sandbox.keepAlive?.().catch(() => {});
  keepAlive();
  const keepAliveTimer = setInterval(keepAlive, SANDBOX_KEEPALIVE_MS);
  const probeTimer = setInterval(async () => {
    if (probing || controller.signal.aborted) return;
    if (Date.now() - lastHeard < silenceMs) {
      failures = 0;
      return;
    }
    probing = true;
    try {
      failures = (await probe().catch(() => false)) ? 0 : failures + 1;
    } finally {
      probing = false;
    }
    if (failures >= failureLimit && Date.now() - lastHeard >= silenceMs && !controller.signal.aborted) {
      // Stop extending a dead box before the turn unwinds.
      dispose();
      controller.abort(new SandboxUnresponsiveError());
    }
  }, options.intervalMs ?? PROBE_INTERVAL_MS);
  keepAliveTimer.unref?.();
  probeTimer.unref?.();

  function dispose(): void {
    clearInterval(keepAliveTimer);
    clearInterval(probeTimer);
  }

  return {
    signal: controller.signal,
    heard() {
      lastHeard = Date.now();
    },
    dispose,
  };
}

/** Ping an open runtime socket on a timer and report every pong; returns the stop function. */
export function pingRuntimeSocket(
  socket: WebSocket,
  onPong: () => void,
  intervalMs: number = RUNTIME_STREAM_PING_MS,
): () => void {
  socket.addEventListener("pong", onPong);
  const timer = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.ping();
  }, intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    socket.removeEventListener("pong", onPong);
  };
}
