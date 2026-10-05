import type { SandboxHandle } from "../sandboxes/provider";
import { invalidateRuntimeEnvironmentAccess } from "./runtime-environment-client";
import { restartRuntimeEnvironment, runtimeEnvironmentHealthy } from "./runtime-environment";
import { requestRuntimeRpc } from "./runtime-event-stream";
import { awaitRuntimeProviderReady, type RuntimeProviderReadiness } from "./runtime-provider-bridge";

/** How long the first look at the status cache may take before T3 is asked to re-check. */
const QUICK_PROBE_MS = 1_500;

export interface RuntimeProviderBarrierDependencies {
  readonly awaitReady: typeof awaitRuntimeProviderReady;
  readonly restart: typeof restartRuntimeEnvironment;
  readonly invalidateAccess: typeof invalidateRuntimeEnvironmentAccess;
  /** Whether the runtime server is up at all. Absent in tests means "up". */
  readonly healthy?: typeof runtimeEnvironmentHealthy;
  /** Ask T3 to re-check one provider instance now. Absent: wait for T3's own check. */
  readonly refresh?: (
    sandbox: SandboxHandle,
    instanceId: string,
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<boolean>;
}

const runtimeProviderBarrierDependencies: RuntimeProviderBarrierDependencies = {
  awaitReady: awaitRuntimeProviderReady,
  restart: restartRuntimeEnvironment,
  invalidateAccess: invalidateRuntimeEnvironmentAccess,
  healthy: runtimeEnvironmentHealthy,
  refresh: (sandbox, instanceId, signal, timeoutMs) =>
    requestRuntimeRpc(sandbox, "server.refreshProviders", { instanceId }, signal, timeoutMs),
};

export async function ensureRuntimeProviderReadyForTurn(input: {
  readonly sandbox: SandboxHandle;
  readonly signal: AbortSignal;
  readonly readiness: RuntimeProviderReadiness;
  readonly barrierDeadlineMs: number;
  readonly verifyDeadlineMs: number;
  readonly providerLabel: string;
  readonly dependencies?: RuntimeProviderBarrierDependencies;
}): Promise<void> {
  const dependencies = input.dependencies ?? runtimeProviderBarrierDependencies;
  // A sandbox whose runtime is down cannot fill its status cache no matter how
  // long the barrier waits. Boot straight away instead of burning the whole
  // barrier deadline first; the boot reads the settings written just before it.
  // The baked image usually has the runtime up already; it then takes the
  // settings through its settings watch, and the barrier below covers that.
  const up = dependencies.healthy ? await dependencies.healthy(input.sandbox) : true;
  if (up) {
    const deadline = Date.now() + input.barrierDeadlineMs;
    const remaining = () => Math.max(1, deadline - Date.now());
    const firstLookMs = dependencies.refresh ? Math.min(QUICK_PROBE_MS, input.barrierDeadlineMs) : input.barrierDeadlineMs;
    if (await dependencies.awaitReady(input.sandbox, input.signal, firstLookMs, input.readiness)) return;
    // T3 re-checks a provider only when its settings change or every five
    // minutes. A run's fresh gateway capability is neither (a pooled sandbox
    // was checked before any run's capability existed), so ask for the check
    // now instead of waiting out the deadline and restarting the runtime.
    if (dependencies.refresh) {
      await dependencies.refresh(input.sandbox, input.readiness.instanceId, input.signal, remaining()).catch(() => false);
      if (await dependencies.awaitReady(input.sandbox, input.signal, remaining(), input.readiness)) return;
    }
  }
  input.signal.throwIfAborted();
  await dependencies.restart(input.sandbox, input.signal);
  dependencies.invalidateAccess(input.sandbox);
  input.signal.throwIfAborted();
  if (
    !(await dependencies.awaitReady(
      input.sandbox,
      input.signal,
      input.verifyDeadlineMs,
      input.readiness,
    ))
  ) {
    input.signal.throwIfAborted();
    throw new Error(`${input.providerLabel} runtime did not become ready after restart`);
  }
}
