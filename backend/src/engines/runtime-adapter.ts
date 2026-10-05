import type { EngineAdapter, EngineRunContext } from "./types";
import { composeRunTurnPrompt } from "./types";
import { setTimeout as delay } from "node:timers/promises";
import { acquireThreadSandbox } from "./thread-sandbox";
import {
  awaitRuntimeProviderReady,
  prepareRuntimeProviderBridge,
  prepareStableRuntimeProvider,
  type RuntimeProviderReadiness,
  type RuntimeProviderBridgeLease,
} from "./runtime-provider-bridge";
import {
  buildRuntimeEnvironmentRequestCommand,
  decodeRuntimeEnvironmentCommandOutput,
  invalidateRuntimeEnvironmentAccess,
  requestRuntimeEnvironment,
} from "./runtime-environment-client";
import { awaitCodexProviderReady } from "./codex-subscription-runtime";
import {
  followRuntimeThreadSnapshots,
  subscribeRuntimeThread,
} from "./runtime-event-stream";
import {
  activityStep,
  assistantText,
  hasOpenRuntimeToolCall,
  runtimeActivityStepKey,
  shouldProjectRuntimeActivity,
  runtimeThreadId,
  runtimeUserMessageId,
  runtimeTurnError,
  runtimeTurnSettled,
  type RuntimeEngineId,
  type RuntimeThreadSnapshot,
} from "./runtime-orchestration";
import { configuredRuntimeMode, runtimeModeFor } from "./permission-mode";
import { assertReadOnlyTurnAllowed, ensureRuntimeThreadMode } from "./runtime-thread-mode";
import { refuseReadOnlyRequest, replyToRuntimeApproval, runtimeApprovalRequest } from "./runtime-approval";
import { providerGatewayWired } from "../provider-gateway/sandbox-config";
import { createSecretRedactor } from "../secrets/redact";
import {
  sandboxProviderKind,
  type SandboxHandle,
} from "../sandboxes/provider";
import { sandboxPlugin } from "../sandboxes/plugins";
import type { ProviderDriver } from "@useagent/agent-harness/control";
import { sessionCapabilities } from "./capabilities";
import {
  establishProviderSession,
  recordProviderSessionStarted,
} from "./provider-turn";
import {
  recordRuntimeCommandCatalog,
  runtimeCommandDispatchRejection,
} from "./runtime-command-catalog";
import {
  restartRuntimeEnvironment,
  RUNTIME_CUBE_WARM_POOL_NAME,
  runtimeFirstActivityTimeoutMs,
  runtimeNoProgressTimeoutMs,
  runtimeGeneration,
  RUNTIME_GENERATION,
  RUNTIME_GENERATION_LABEL,
  runtimeEnvironmentHealthy,
} from "./runtime-environment";
import { createNoProgressWatchdog, NoProgressError } from "./turn-no-progress";
import { watchTurnLiveness } from "./turn-liveness";
import { activityRevisions, createTurnProjector, type TurnProjector } from "./turn-projector";
import { RUNTIME_EMPTY_TERMINAL_OUTPUT_ERROR, RuntimeTurnFailedError, continuationRunId, turnRecovery, upstreamCauseLabel } from "./turn-recovery";
import { T3_SESSION_GENERATION, t3ProviderDrivers } from "./t3-provider-driver";
import { operatorEnv } from "./runtime-env";
import { runtimeRunSnapshot } from "./runtime-snapshot";
import { prepareSandboxTurn } from "./sandbox-turn-preparation";
import { buildExecutionCapabilitySnapshot } from "./execution-capabilities";
import { reloadRetainedOpenCodeSession } from "./runtime-session-stop";
import { awaitRuntimeOperation } from "./runtime-operation";
import {
  recoverStuckCodexSubscriptionStart,
  RuntimeFirstActivityTimeoutError,
} from "./runtime-startup-recovery.js";
import { applyPendingCodexProviderConfiguration } from "./runtime-codex-plan-config";
import { waitForRuntimeCompact } from "./runtime-compact-completion";
export {
  reloadRetainedOpenCodeSession,
  type OpenCodeSessionReloadDependencies,
} from "./runtime-session-stop";

export function runtimeSessionHasAuthoritativeHistory(
  resumed: boolean,
  lease: Pick<RuntimeProviderBridgeLease, "authPath" | "hasCurrentEpochThreadBinding">,
): boolean {
  return resumed && (
    lease.authPath !== "subscription" || lease.hasCurrentEpochThreadBinding
  );
}

const RUNTIME_POLL_INTERVAL_MS = 125;
// T3 can publish root idle just before the final assistant projection. Re-read
// for two seconds so that ordering gap is tolerated without accepting no output.
// The final message lands a moment after the runtime signals completion; a loaded sandbox needs more than a couple of seconds.
const RUNTIME_TERMINAL_OUTPUT_DRAIN_MS = 15_000;
const RUNTIME_TERMINAL_OUTPUT_DRAIN_SECONDS = 2;
const RUNTIME_TERMINAL_CLEANUP_MS = 250;
export { RUNTIME_EMPTY_TERMINAL_OUTPUT_ERROR } from "./turn-recovery";
export { projectRuntimeAssistantText } from "./turn-projector";
// Codex subscription writes its per-run relay config into the sandbox's T3
// settings.json, which T3 applies through an asynchronous settings-watch
// reconcile. Wait for the reconcile to publish the remote instance before
// steering; if it does not land in time, fall back to a deterministic restart.
const CODEX_BARRIER_DEADLINE_MS = 5_000;
const CODEX_VERIFY_DEADLINE_MS = 8_000;
// T3's authoritative Claude health check includes a 4s CLI version probe and
// a prompt-free SDK initialization bounded at 25s. Leave scheduling margin
// without adding a second CLI retry loop in Pro.
const CLAUDE_BARRIER_DEADLINE_MS = 35_000;
const CLAUDE_VERIFY_DEADLINE_MS = 35_000;

interface RuntimeProviderBarrierDependencies {
  readonly awaitReady: typeof awaitRuntimeProviderReady;
  readonly restart: typeof restartRuntimeEnvironment;
  readonly invalidateAccess: typeof invalidateRuntimeEnvironmentAccess;
  /** Whether the runtime server is up at all. Absent in tests means "up". */
  readonly healthy?: typeof runtimeEnvironmentHealthy;
}

const runtimeProviderBarrierDependencies: RuntimeProviderBarrierDependencies = {
  awaitReady: awaitRuntimeProviderReady,
  restart: restartRuntimeEnvironment,
  invalidateAccess: invalidateRuntimeEnvironmentAccess,
  healthy: runtimeEnvironmentHealthy,
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
  if (
    up &&
    (await dependencies.awaitReady(
      input.sandbox,
      input.signal,
      input.barrierDeadlineMs,
      input.readiness,
    ))
  ) {
    return;
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

interface RuntimeShellSnapshot {
  readonly projects: readonly { readonly id: string }[];
  readonly threads: readonly { readonly id: string }[];
}

export { runtimeRunSnapshot };

export { configuredRuntimeMode } from "./permission-mode";

async function readThreadSnapshot(
  ctx: EngineRunContext,
  sandbox: Awaited<ReturnType<typeof acquireThreadSandbox>>["sandbox"],
  signal: AbortSignal = ctx.signal,
): Promise<RuntimeThreadSnapshot> {
  return await requestRuntimeEnvironment<RuntimeThreadSnapshot>(
    sandbox,
    {
      method: "GET",
      path: `/api/orchestration/threads/${encodeURIComponent(runtimeThreadId(ctx))}`,
    },
    signal,
  );
}

export async function drainRuntimeTerminalOutput(input: {
  readonly initialText: string;
  readonly fallbackText: string;
  readonly signal: AbortSignal;
  readonly readAndApplySnapshot: (signal: AbortSignal) => Promise<string>;
  readonly deadlineSignal?: AbortSignal;
}): Promise<string> {
  let text = input.initialText;
  const deadlineSignal = input.deadlineSignal ?? AbortSignal.timeout(RUNTIME_TERMINAL_OUTPUT_DRAIN_MS);
  const drainSignal = AbortSignal.any([input.signal, deadlineSignal]);

  while (!text.trim()) {
    try {
      input.signal.throwIfAborted();
      await delay(RUNTIME_POLL_INTERVAL_MS, undefined, { signal: drainSignal });
      text = await input.readAndApplySnapshot(drainSignal);
      input.signal.throwIfAborted();
      if (text.trim()) return text;
      deadlineSignal.throwIfAborted();
    } catch (error) {
      if (input.signal.aborted) throw input.signal.reason;
      if (deadlineSignal.aborted) {
        if (input.fallbackText.trim()) return input.fallbackText;
        throw new Error(RUNTIME_EMPTY_TERMINAL_OUTPUT_ERROR);
      }
      throw error;
    }
  }
  input.signal.throwIfAborted();
  return text;
}

export function createRuntimeTerminalSessionCleanup(
  sandbox: Awaited<ReturnType<typeof acquireThreadSandbox>>["sandbox"],
  sessionId: string,
  options: {
    readonly deadlineSignal?: AbortSignal;
    readonly warn?: (message: string, context: Record<string, string>) => void;
  } = {},
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let warned = false;
  return () => {
    if (inFlight) return inFlight;
    const deadline = options.deadlineSignal ?? AbortSignal.timeout(RUNTIME_TERMINAL_CLEANUP_MS);
    const operation: Promise<void> = awaitRuntimeOperation(
      sandbox.process.deleteSession(sessionId), deadline, async () => {},
    ).then(() => {}).catch((error) => {
        if (warned) return;
        warned = true;
        (options.warn ?? ((message, context) => console.warn(message, context)))(
          "[runtime-terminal-drain] session cleanup failed",
          { sessionId, error: error instanceof Error ? error.message : String(error) },
        );
      });
    inFlight = operation.finally(() => {
      inFlight = null;
    });
    return inFlight!;
  };
}

export async function readRuntimeTerminalSnapshot(
  ctx: EngineRunContext,
  sandbox: Awaited<ReturnType<typeof acquireThreadSandbox>>["sandbox"],
  signal: AbortSignal,
): Promise<RuntimeThreadSnapshot> {
  const sessionId = `useagent-terminal-drain-${crypto.randomUUID()}`;
  const cleanup = createRuntimeTerminalSessionCleanup(sandbox, sessionId);
  try {
    await awaitRuntimeOperation(sandbox.process.createSession(sessionId), signal, cleanup);
    const result = await awaitRuntimeOperation(
      sandbox.process.executeSessionCommand(sessionId, {
        command: buildRuntimeEnvironmentRequestCommand({
          method: "GET",
          path: `/api/orchestration/threads/${encodeURIComponent(runtimeThreadId(ctx))}`,
        }),
        runAsync: false,
      }, RUNTIME_TERMINAL_OUTPUT_DRAIN_SECONDS),
      signal,
      cleanup,
    );
    const response = decodeRuntimeEnvironmentCommandOutput(
      result.output ?? `${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
    if ((result.exitCode ?? 1) !== 0 || response.status === undefined || response.status >= 400) {
      throw new Error("The provider runtime terminal snapshot request failed");
    }
    return JSON.parse(response.body) as RuntimeThreadSnapshot;
  } finally {
    await cleanup();
  }
}

interface RuntimeTurnWaitDependencies {
  readonly readThreadSnapshot: typeof readThreadSnapshot;
  readonly subscribeRuntimeThread: typeof subscribeRuntimeThread;
  /** How a read-only run declines a request; the real reply path unless a test injects one. */
  readonly replyToRuntimeApproval?: typeof replyToRuntimeApproval;
  readonly watchLiveness?: typeof watchTurnLiveness;
}

const runtimeTurnWaitDependencies: RuntimeTurnWaitDependencies = {
  readThreadSnapshot,
  subscribeRuntimeThread,
  replyToRuntimeApproval,
};

export async function waitForRuntimeTurn(
  ctx: EngineRunContext,
  sandbox: Awaited<ReturnType<typeof acquireThreadSandbox>>["sandbox"],
  preExistingActivities: ReadonlyMap<string, string>,
  priorSnapshot: RuntimeThreadSnapshot,
  redact: ReturnType<typeof createSecretRedactor>,
  dependencies: RuntimeTurnWaitDependencies = runtimeTurnWaitDependencies,
  engine: RuntimeEngineId | null = null,
  projector: TurnProjector = createTurnProjector({ ctx, redact, engine, seen: preExistingActivities }),
): Promise<string> {
  // Single owner of the turn-stream no-progress bound: a provider retry storm
  // (only runtime.warning activities, no tool/text progress) must terminate
  // the run with the real provider reason instead of running forever.
  const watchdog = createNoProgressWatchdog(runtimeNoProgressTimeoutMs(), redact.text);
  // A long-running tool emits no new activity revisions while it executes, so
  // the event stream goes silent even though the turn is making real progress.
  // While the latest snapshot shows an open tool call, tick the watchdog on a
  // timer; provider stalls (no tool running, no text) stay fully guarded.
  let toolInFlight = false;
  const toolHeartbeat = setInterval(() => {
    if (toolInFlight) {
      watchdog.observeProgress();
      ctx.reportActivity?.();
    }
  }, 15_000);
  toolHeartbeat.unref?.();
  // Keeps the sandbox's lifetime clock pushed out while the turn runs; fails the
  // turn only when the sandbox stops answering, never because it is slow.
  const liveness = (dependencies.watchLiveness ?? watchTurnLiveness)(sandbox);
  const threadId = runtimeThreadId(ctx);
  const priorTurnId = priorSnapshot.thread.latestTurn?.turnId ?? null;
  let currentTurnObserved = false;
  const firstActivityDeadline = new AbortController();
  const firstActivityTimer = setTimeout(
    () => firstActivityDeadline.abort(),
    runtimeFirstActivityTimeoutMs(),
  );
  firstActivityTimer.unref?.();
  const streamSignal = AbortSignal.any([
    ctx.signal,
    watchdog.signal,
    firstActivityDeadline.signal,
    liveness.signal,
  ]);
  // A read-only run answers the runtime's own approval requests itself: every
  // command and file change is declined the moment it is recorded, through the
  // same reply path a person uses, so the sandbox never writes and the record
  // shows the refusal. Reads pass; a person may still answer those.
  const refusedRequests = new Set<string>();
  const observe = async (activity: RuntimeThreadSnapshot["thread"]["activities"][number]): Promise<void> => {
    watchdog.observeActivity(activity);
    if (ctx.permissionMode !== "read-only") return;
    const request = runtimeApprovalRequest(activity, threadId);
    if (!request || refusedRequests.has(request.id)) return;
    refusedRequests.add(request.id);
    const refused = await refuseReadOnlyRequest({
      runId: ctx.runId,
      threadId: ctx.threadId ?? ctx.runId,
      sessionId: threadId,
      request,
      signal: ctx.signal,
      expectedSandbox: ctx.expectedSandbox ?? null,
    }, dependencies.replyToRuntimeApproval);
    if (refused) await ctx.emit(refused.step);
  };
  const applySnapshot = async (snapshot: RuntimeThreadSnapshot): Promise<boolean> => {
    const applied = await projector.apply(snapshot, observe);
    toolInFlight = applied.toolInFlight;
    if (applied.delta) watchdog.observeProgress();
    if (applied.error) throw new RuntimeTurnFailedError(applied.error);
    return !applied.settled;
  };
  const acceptSnapshot = async (snapshot: RuntimeThreadSnapshot): Promise<boolean> => {
    const latestTurnId = snapshot.thread.latestTurn?.turnId ?? null;
    if (!currentTurnObserved) {
      if (latestTurnId === null || latestTurnId === priorTurnId) return true;
      currentTurnObserved = true;
      clearTimeout(firstActivityTimer);
    }
    return await applySnapshot(snapshot);
  };

  // Snapshot mode attaches live delivery before the runtime reads the thread, so
  // nothing between dispatch and subscribe is lost; events then apply in place.
  let streamError: unknown;
  try {
    await followRuntimeThreadSnapshots({
      sandbox,
      threadId,
      initialSequence: priorSnapshot.snapshotSequence,
      signal: streamSignal,
      readSnapshot: (signal) => dependencies.readThreadSnapshot(ctx, sandbox, signal),
      applySnapshot: acceptSnapshot,
      subscribe: dependencies.subscribeRuntimeThread,
      onHeard: liveness.heard,
      onRead: (durationMs) => ctx.timing?.add?.("t3.snapshot_reads", durationMs),
    });
  } catch (error) {
    streamError = error;
  } finally {
    clearTimeout(firstActivityTimer);
    clearInterval(toolHeartbeat);
    liveness.dispose();
    watchdog.dispose();
  }
  if (watchdog.signal.aborted) throw watchdog.signal.reason;
  ctx.signal.throwIfAborted();
  if (liveness.signal.aborted) throw liveness.signal.reason;
  if (firstActivityDeadline.signal.aborted && !currentTurnObserved) {
    throw new RuntimeFirstActivityTimeoutError(runtimeFirstActivityTimeoutMs());
  }
  if (streamError) throw streamError;
  if (!currentTurnObserved) {
    throw new Error("Provider thread subscription ended before the dispatched turn was observed");
  }
  return await drainRuntimeTerminalOutput({
    initialText: projector.finalText,
    fallbackText: projector.publishedText,
    signal: ctx.signal,
    readAndApplySnapshot: async (drainSignal) => {
      await applySnapshot(await readRuntimeTerminalSnapshot(ctx, sandbox, drainSignal));
      return projector.finalText;
    },
  });
}

export function makeRuntimeAdapter(engine: RuntimeEngineId, driver: ProviderDriver): EngineAdapter {
  return {
    id: engine,
    async run(ctx): Promise<void> {
      if (!providerGatewayWired()) {
        throw new Error("Engine requires a configured provider gateway");
      }
      const startedAt = Date.now();
      await ctx.emit({
        kind: "task",
        label: "Preparing runtime and integrations…",
        chip: `runtime:${engine}`,
      });
      let stableProviderPendingRevision: string | null = null;
      const prepared = await prepareSandboxTurn(ctx, {
        snapshot: runtimeRunSnapshot(),
        chip: `runtime:${engine}`,
        warmPool: RUNTIME_CUBE_WARM_POOL_NAME,
        labels: { [RUNTIME_GENERATION_LABEL]: RUNTIME_GENERATION },
        requiredLabels: { [RUNTIME_GENERATION_LABEL]: RUNTIME_GENERATION },
        providerAfterResources: engine === "claude",
        resourceUser: engine === "claude"
          ? (binding) => sandboxPlugin(binding.kind).runsAsRoot
            ? { uid: 1000, gid: 1000, home: "/home/user" }
            : undefined
          : undefined,
        // Frozen timing prefix: hosted cutover canaries read these values.
        timingPrefix: "t3",
        async prepareStableProvider(sandbox) {
          stableProviderPendingRevision = await prepareStableRuntimeProvider(sandbox, ctx, engine);
        },
        async prepareProvider(sandbox, workdir, binding, preparation) {
          return await prepareRuntimeProviderBridge(
            sandbox,
            ctx,
            engine,
            workdir,
            preparation.stableProviderPrepared,
            binding,
            stableProviderPendingRevision,
          );
        },
        closeProvider: (state) => state.close(),
      });
      const { sandbox, workdir, redact } = prepared;
      const providerBridgeLease: RuntimeProviderBridgeLease = prepared.providerState;
      const controlMetadata = ctx.expectedSandbox
        ? { expectedSandbox: ctx.expectedSandbox, threadId: ctx.threadId ?? ctx.runId }
        : undefined;

      try {
        // A warm T3 process may still own a Codex app-server launched from the
        // previous stable settings. When the host changes those settings,
        // restart once before session lookup so T3 boots the new argv and then
        // resumes the retained native thread from its persisted cursor.
        if (
          engine === "codex" &&
          providerBridgeLease.authPath !== "subscription" &&
          providerBridgeLease.pendingProviderConfigurationRevision
        ) {
          const endBarrier = ctx.timing?.begin("t3.prepare.runtime_barrier");
          try {
            await applyPendingCodexProviderConfiguration({
              sandbox,
              signal: ctx.signal,
              revision: providerBridgeLease.pendingProviderConfigurationRevision,
              timing: ctx.timing,
            });
          } finally {
            endBarrier?.();
          }
        }

        // Claude also patches T3 settings.json above. The explicit provider
        // instance carries a unique display marker, so the cache probe proves
        // T3 applied the gateway-backed wrapper rather than merely observing
        // that the settings file exists.
        if (providerBridgeLease.readiness) {
          const endBarrier = ctx.timing?.begin("t3.prepare.runtime_barrier");
          try {
            await ensureRuntimeProviderReadyForTurn({
              sandbox,
              signal: ctx.signal,
              readiness: providerBridgeLease.readiness,
              barrierDeadlineMs: CLAUDE_BARRIER_DEADLINE_MS,
              verifyDeadlineMs: CLAUDE_VERIFY_DEADLINE_MS,
              providerLabel: "Claude",
            });
          } finally {
            endBarrier?.();
          }
        }

        // Codex subscription patches its per-run relay config into the sandbox's
        // T3 settings.json above (provider_bridge). T3 only applies settings via
        // an asynchronous settings-watch reconcile, so a turn dispatched before
        // that reconcile binds to the pre-reconcile, relay-less codex instance and
        // falls back to a local, unauthenticated app-server (no first activity).
        // Scoped to subscription Codex. Provider-gateway Codex does not create
        // a per-run instance, and Claude has its own marker barrier above. The
        // no-first-activity watchdog below remains the final safety net.
        if (providerBridgeLease?.authPath === "subscription") {
          const endBarrier = ctx.timing?.begin("t3.prepare.runtime_barrier");
          try {
            // A sandbox whose runtime is down cannot publish the status cache,
            // so polling it only spends the barrier deadline. Boot now (timed as
            // runtime.readiness); the boot reads the relay config written above.
            // A runtime the image booted already is up and takes the relay
            // config through its settings watch; the barrier below waits for it.
            const up = await runtimeEnvironmentHealthy(sandbox);
            // (B) Barrier: wait for the reconcile to publish the subscription
            // (relay-backed) codex instance into its status cache. Content, not
            // mtime: health refreshes rewrite the cache for the legacy instance
            // too. Fast path, no restart cost.
            if (
              !up ||
              !(await awaitCodexProviderReady(sandbox, ctx.signal, CODEX_BARRIER_DEADLINE_MS))
            ) {
              // (A) Fallback: the reconcile did not land in time. Bounce T3 so boot
              // reads the relay config synchronously and builds the remote instance
              // from the start, then verify once before steering. Honest error if
              // the runtime never reports ready.
              await restartRuntimeEnvironment(sandbox, ctx.signal, ctx.timing);
              invalidateRuntimeEnvironmentAccess(sandbox);
              if (
                !(await awaitCodexProviderReady(sandbox, ctx.signal, CODEX_VERIFY_DEADLINE_MS))
              ) {
                throw new Error("Codex runtime did not become ready after restart");
              }
            }
          } finally {
            endBarrier?.();
          }
        }

        const endShell = ctx.timing?.begin("t3.shell");
        const shell = await requestRuntimeEnvironment<RuntimeShellSnapshot>(
          sandbox,
          { method: "GET", path: "/api/orchestration/shell" },
          ctx.signal,
        );
        endShell?.();
        const threadId = runtimeThreadId(ctx);
        const threadExists = shell.threads.some((thread) => thread.id === threadId);
        // A read-only turn never resumes a thread that may hold a session grant.
        await assertReadOnlyTurnAllowed({ threadId: ctx.threadId ?? ctx.runId, permissionMode: ctx.permissionMode, threadExists });
        if (engine === "opencode") {
          const limitsApplied = await reloadRetainedOpenCodeSession({
            sandbox,
            signal: ctx.signal,
            threadId,
            threadExists,
            modelLimitsChanged: providerBridgeLease.modelLimitsChanged,
            modelLimitsRevision: providerBridgeLease.modelLimitsRevision,
          });
          // A declined stop leaves the refresh owed, so the next turn tries again.
          if (limitsApplied) await providerBridgeLease.ackModelLimitsReload();
        }
        const createdAt = new Date().toISOString();
        // The run's own policy; the operator posture only covers runs created without one.
        const runtimeMode = runtimeModeFor(ctx.permissionMode ?? configuredRuntimeMode());
        const negotiatedCapabilities = sessionCapabilities(engine, {
          desktop: false,
          knowledgeTools: true,
          runtimeOrchestration: true,
        });
        const executionCapabilities = buildExecutionCapabilitySnapshot({
          runtime: "sandbox",
          workspaceRoot: workdir,
          gatewayAvailable: true,
          desktopAvailability: "on_demand",
        });
        const established = await establishProviderSession({
          driver,
          ctx,
          runtime: { kind: "sandbox", id: sandbox.id },
          capabilities: negotiatedCapabilities,
          executionCapabilities,
          generation: T3_SESSION_GENERATION,
          authEpoch: providerBridgeLease.authEpoch,
          priorSessionId: threadExists ? threadId : undefined,
          startMetadata: { workspaceRoot: workdir, runtimeMode, createdAt, shell },
          persistSession: async (providerSession) => {
            if (!ctx.saveProviderSession) {
              throw new Error("Session persistence is unavailable");
            }
            await ctx.saveProviderSession(providerSession, providerBridgeLease.authEpoch);
          },
        });
        const session = established.session;
        // `start()` may adopt a thread the runtime already projected even when
        // the durable provider lifecycle is fresh. Always capture its current
        // turn before steering so an initialization greeting cannot be mistaken
        // for the response to this run.
        // The runtime runs a turn with the mode stored on its THREAD, so a run
        // whose mode differs from the thread's (a reply that changed it) sets the
        // thread's mode and proceeds only once the runtime reports it.
        const priorSnapshot = await ensureRuntimeThreadMode({
          sandbox,
          threadId,
          runtimeMode,
          snapshot: await readThreadSnapshot(ctx, sandbox),
          signal: ctx.signal,
        });

        // HTTP orchestration dispatch validates thread.turn.start against an
        // already-projected thread. ProviderDriver.start creates it explicitly instead of
        // relying on the websocket-only bootstrap normalization path.
        const prompt = await composeRunTurnPrompt(
          ctx,
          runtimeSessionHasAuthoritativeHistory(established.resumed, providerBridgeLease),
          executionCapabilities,
        );
        await recordProviderSessionStarted(ctx, session, {
          provider: "t3",
          source: engine,
          resumed: established.resumed,
        });
        // The session's native command list, recorded with the session so the
        // reply composer's typed commands and Compact authorize against it.
        await recordRuntimeCommandCatalog({ ctx, sandbox, engine, session });
        let turnInput = { kind: "prompt" as const, text: prompt, model: ctx.model, reasoningEffort: ctx.reasoningEffort };
        let turnBase = priorSnapshot;
        let projector = createTurnProjector({ ctx, redact, engine, seen: activityRevisions(priorSnapshot) });
        let attempt = 1;
        // Each attempt is requested at its own time: the runtime keeps the
        // request time on the turn, and recovery tells attempts apart by it.
        let turnRequestedAt = createdAt;
        const endTurn = ctx.timing?.begin("t3.turn_wait");
        let skipQueuedCancel = false;
        try {
          for (;;) {
            const createdAt = turnRequestedAt;
            if (ctx.commandName) {
              const command = {
                name: ctx.commandName, provider: ctx.commandProvider ?? null,
                sessionId: ctx.commandSessionId ?? null, catalogRevision: ctx.commandCatalogRevision ?? null,
              };
              const rejection = await runtimeCommandDispatchRejection({ ctx, sandbox, engine, session, command });
              if (rejection) throw new Error(`Native command dispatch rejected: ${rejection}`);
            }
            ctx.timing?.mark("dispatch");
            const endDispatch = ctx.timing?.begin("t3.dispatch_request");
            const steerResult = await driver.steer({
              runId: attempt === 1 ? ctx.runId : continuationRunId(ctx.runId, attempt),
              threadId: ctx.threadId ?? ctx.runId,
              session,
              input: turnInput,
              metadata: controlMetadata
                ? { runtimeMode, createdAt, ...controlMetadata }
                : { runtimeMode, createdAt },
              signal: ctx.signal,
            });
            endDispatch?.();
            if (steerResult.status !== "ok") {
              throw new Error(`the provider runtime ${engine} steer failed (${steerResult.status}): ${steerResult.message ?? "unsupported"}`);
            }
            // Delivery evidence, separate from session authority: only an accepted
            // steer proves this prompt, and the history it carried, reached the engine.
            await ctx.markPromptDelivered?.();
            await ctx.emit({ kind: "task", label: "Waiting for provider activity…", chip: `runtime:${engine}` });
            try {
              const summary = ctx.commandName === "compact"
                ? await waitForRuntimeCompact(
                    ctx, sandbox, turnBase, redact, runtimeUserMessageId(ctx.runId), runtimeTurnWaitDependencies,
                  )
                : await waitForRuntimeTurn(
                    ctx, sandbox, projector.seen(), turnBase, redact, runtimeTurnWaitDependencies, engine, projector,
                  );
              await ctx.emit({ kind: "done", label: "Done", chip: null });
              ctx.setSummary(summary, Date.now() - startedAt);
              break;
            } catch (error) {
              if (ctx.commandName === "compact") throw error;
              if (
                providerBridgeLease.authPath === "subscription" &&
                (error instanceof RuntimeFirstActivityTimeoutError || ctx.signal.aborted)
              ) {
                const recovery = await recoverStuckCodexSubscriptionStart({
                  error,
                  ctx,
                  sandbox,
                  lease: providerBridgeLease,
                  priorTurnId: turnBase.thread.latestTurn?.turnId ?? null,
                });
                skipQueuedCancel = recovery.stuckStartConfirmed;
                throw recovery.error;
              }
              if (error instanceof NoProgressError && !ctx.signal.aborted) {
                // The durable run is failing with the provider's real reason; also
                // stop the sandbox-side turn so a persistent thread does not keep
                // retrying against the provider gateway. Best-effort only: a cancel
                // failure must not mask the no-progress reason.
                await driver.cancel(session, "provider made no progress", controlMetadata).catch(() => {});
                throw error;
              }
              // A turn that may still be running is never steered again; only a
              // settled failure (no answer, or a transient provider error the
              // runtime reported) gets one continuation before it stands.
              if (error instanceof RuntimeFirstActivityTimeoutError || ctx.signal.aborted) throw error;
              const recovery = turnRecovery(error, attempt);
              if (!recovery) {
                const cause = await upstreamCauseLabel(ctx.runId, error);
                if (cause) await ctx.emit({ kind: "task", label: cause, chip: `runtime:${engine}` });
                throw error;
              }
              attempt += 1;
              if (recovery.delayMs > 0) await delay(recovery.delayMs, undefined, { signal: ctx.signal });
              // Whatever landed after the wait gave up goes through the same
              // projector, so the record keeps it and the continuation does not
              // take it for old. An answer that landed late is the answer.
              const settledSnapshot = await readThreadSnapshot(ctx, sandbox);
              await projector.apply(settledSnapshot);
              if (recovery.answerMayBeLate && projector.finalText.trim()) {
                await ctx.emit({ kind: "done", label: "Done", chip: null });
                ctx.setSummary(projector.finalText, Date.now() - startedAt);
                break;
              }
              await ctx.emit({ kind: "task", label: recovery.label, chip: `runtime:${engine}` });
              turnBase = settledSnapshot;
              turnRequestedAt = new Date().toISOString();
              projector = createTurnProjector({ ctx, redact, engine, seen: projector.seen(), steps: projector.steps() });
              turnInput = { kind: "prompt" as const, text: recovery.prompt, model: ctx.model, reasoningEffort: ctx.reasoningEffort };
            }
          }
          // The runtime rewrites its snapshot when the provider's command list
          // changes (a command this turn created, a refreshed provider); read it
          // again once the turn settled so the next reply composes against the
          // current catalog. An unchanged list records nothing.
          await recordRuntimeCommandCatalog({ ctx, sandbox, engine, session });
        } finally {
          endTurn?.();
          if (ctx.signal.aborted && !skipQueuedCancel && ctx.commandName !== "compact") {
            const cancelResult = await driver.cancel(
              session,
              "turn aborted",
              controlMetadata,
            );
            if (cancelResult.status !== "ok") {
              throw new Error(
                `the provider runtime ${engine} cancel failed (${cancelResult.status}): ${cancelResult.message ?? "unsupported"}`,
              );
            }
          }
        }
      } finally {
        await prepared.close().catch(() => {});
      }
    },
  };
}

export const runtimeCodexAdapter = makeRuntimeAdapter("codex", t3ProviderDrivers.codex);
export const runtimeClaudeAdapter = makeRuntimeAdapter("claude", t3ProviderDrivers.claude);
export const runtimeOpenCodeAdapter = makeRuntimeAdapter("opencode", t3ProviderDrivers.opencode);
