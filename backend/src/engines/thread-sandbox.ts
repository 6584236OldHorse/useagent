import { SandboxNotFoundError } from "@useagent/sandbox-contract";
import { getThreadSandbox, setRunSandbox } from "../runs/repo";
import { sandboxProviderKind, type SandboxHandle } from "../sandboxes/provider";
import { runtimeRunSnapshot } from "./runtime-snapshot";
import { claimCubeWarmSandbox } from "../sandboxes/cube-warm-pool";
import {
  providerGatewaySandboxIsCurrent,
  providerGatewaySandboxLabels,
} from "../provider-gateway/sandbox-config";
import { RUN_TIMING_OUTCOMES, RUN_TIMING_STAGES } from "../runs/run-timing";
import { persistSandboxBeforeExecution } from "./util";
import type { EngineRunContext } from "./types";
import {
  forgetLiveThreadSandbox,
  getLiveThreadSandbox,
  rememberLiveThreadSandbox,
} from "./sandbox-runtime";
import {
  assertSandboxResources,
  resolveSandboxResourceTarget,
  sandboxMeetsResourceTarget,
} from "./daytona-resources";
import { assertExpectedSandboxBinding, ExpectedSandboxMismatchError, bindingRecord, resolveSandboxBindingForRun, resolveSandboxBindingForSandbox, resolveSandboxBindingForThread, type SandboxBinding } from "../sandboxes/binding";
import { provisionSandbox } from "./sandbox-provision";
import { noteLostWorkspace } from "./workspace-continuity";

export interface ThreadSandboxLease {
  readonly sandbox: SandboxHandle;
  readonly binding: SandboxBinding;
  readonly reused: boolean;
  readonly retained: boolean;
  readonly releaseAfterRun: boolean;
}

export interface ThreadSandboxOptions {
  readonly snapshot: string;
  readonly chip: string;
  readonly warmPool?: string | false;
  readonly labels?: Readonly<Record<string, string>>;
  readonly requiredLabels?: Readonly<Record<string, string>>;
  /** Filled by acquisition from deployment policy before retained reuse. */
  readonly minimumResources?: ReturnType<typeof resolveSandboxResourceTarget>;
  /** A retained sandbox is up: the turn may issue its read-only checks now,
   * alongside the credential check that still decides whether it is used. */
  readonly onRetainedStarted?: (sandbox: SandboxHandle, binding: SandboxBinding) => void;
}

/**
 * The template a NEW sandbox starts from: a personal computer's own snapshot;
 * the caller's snapshot on the deployment's default provider; and, when the
 * binding is a member's preferred provider, that provider's own runtime
 * template, since the default provider's template name means nothing there.
 */
export function snapshotForBinding(
  binding: SandboxBinding,
  snapshot: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (binding.credential === "user") return binding.snapshot ?? "";
  return binding.kind === sandboxProviderKind(env) ? snapshot : runtimeRunSnapshot(env, binding.kind);
}

export function sandboxHasRequiredLabels(
  sandbox: Pick<SandboxHandle, "labels">,
  required: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!required) return true;
  return Object.entries(required).every(([name, value]) => sandbox.labels?.[name] === value);
}

/**
 * Re-attach to a thread's retained sandbox: resolve the binding that created it
 * (a user's computer or the deployment's provider), wake it if it was stopped,
 * and refuse one whose credential generation is obsolete. Throws when the
 * sandbox cannot be reused; incompatibility preserves it for migration. Shared by every
 * engine so the reuse rules exist once.
 */
export async function reviveRetainedSandbox(
  ctx: EngineRunContext,
  sandboxId: string,
  options: {
    readonly chip: string;
    readonly onResume?: () => void;
    readonly onStarted?: (sandbox: SandboxHandle, binding: SandboxBinding) => void;
  },
  dependencies = {
    threadBinding: resolveSandboxBindingForThread,
    sandboxBinding: resolveSandboxBindingForSandbox,
    credentialsCurrent: providerGatewaySandboxIsCurrent,
  },
): Promise<{ sandbox: SandboxHandle; binding: SandboxBinding }> {
  const expected = ctx.expectedSandbox;
  if (expected && (!ctx.orgId || !ctx.threadId || expected.sandboxId !== sandboxId)) {
    throw new ExpectedSandboxMismatchError();
  }
  const cached = ctx.threadId ? getLiveThreadSandbox(ctx.threadId) : null;
  const binding = ctx.threadId && ctx.orgId
    ? await dependencies.threadBinding(ctx.orgId, ctx.threadId, expected ? { expectedSandbox: expected } : undefined)
    : await dependencies.sandboxBinding(sandboxId);
  if (expected) assertExpectedSandboxBinding(expected, binding, ctx.orgId!, sandboxId);
  let sandbox: SandboxHandle;
  if (!expected && cached?.id === sandboxId) {
    sandbox = cached;
  } else {
    sandbox = await binding.provider.get(sandboxId);
  }
  if (expected && sandbox.id !== expected.sandboxId) throw new ExpectedSandboxMismatchError();
  const state = (sandbox as { state?: string }).state;
  if (state === "stopped" || state === "paused" || state === "archived") {
    await ctx.emit({ kind: "task", label: `Resuming thread sandbox ${sandbox.id.slice(0, 8)}…`, chip: options.chip });
    await sandbox.start();
    options.onResume?.();
  } else if (state !== "started") {
    throw new Error(`unusable state: ${state}`);
  } else {
    options.onStarted?.(sandbox, binding);
  }
  if (!(await dependencies.credentialsCurrent(sandbox))) {
    throw new RetainedSandboxRuntimeMismatchError("credential-isolation");
  }
  return { sandbox, binding };
}

export class RetainedSandboxRuntimeMismatchError extends Error {
  constructor(reason: "runtime" | "credential-isolation" | "resource" = "runtime") {
    super(`The retained workspace requires a compatible ${reason} upgrade. Its files were preserved; a safe migration is required before this thread can resume.`);
    this.name = "RetainedSandboxRuntimeMismatchError";
  }
}

export async function resolveRetainedSandbox(
  ctx: EngineRunContext,
  options: ThreadSandboxOptions,
  dependencies = {
    getSandboxId: getThreadSandbox,
    revive: reviveRetainedSandbox,
    forget: forgetLiveThreadSandbox,
  },
): Promise<{ sandbox: SandboxHandle; binding: SandboxBinding } | null> {
  if (ctx.expectedSandbox && !ctx.threadId) throw new ExpectedSandboxMismatchError();
  if (!ctx.threadId) return null;
  const sandboxId = await dependencies.getSandboxId(ctx.threadId);
  if (ctx.expectedSandbox && sandboxId !== ctx.expectedSandbox.sandboxId) throw new ExpectedSandboxMismatchError();
  if (!sandboxId) return null;
  try {
    const { sandbox, binding } = await dependencies.revive(ctx, sandboxId, {
      chip: options.chip,
      onStarted: options.onRetainedStarted,
    });
    if (!sandboxHasRequiredLabels(sandbox, options.requiredLabels)) {
      throw new RetainedSandboxRuntimeMismatchError();
    }
    if (options.minimumResources && !sandboxMeetsResourceTarget(sandbox, options.minimumResources)) {
      throw new RetainedSandboxRuntimeMismatchError("resource");
    }
    return { sandbox, binding };
  } catch (error) {
    if (error instanceof RetainedSandboxRuntimeMismatchError) throw error;
    if (error instanceof SandboxNotFoundError) {
      if (ctx.expectedSandbox) throw new ExpectedSandboxMismatchError();
      dependencies.forget(ctx.threadId, sandboxId);
      return null;
    }
    throw error;
  }
}

export async function acquireThreadSandbox(
  ctx: EngineRunContext,
  options: ThreadSandboxOptions,
  dependencies = {
    retained: resolveRetainedSandbox,
    bindingForThread: resolveSandboxBindingForThread,
    bindingForRun: resolveSandboxBindingForRun,
    persist: setRunSandbox,
  },
): Promise<ThreadSandboxLease> {
  const resourceTarget = resolveSandboxResourceTarget();
  const endRetained = ctx.timing?.begin(RUN_TIMING_STAGES.sandboxRetained);
  let retained: { sandbox: SandboxHandle; binding: SandboxBinding } | null;
  try {
    retained = await dependencies.retained(ctx, { ...options, minimumResources: resourceTarget });
  } catch (error) {
    endRetained?.(RUN_TIMING_OUTCOMES.failure);
    throw error;
  }
  endRetained?.(retained ? RUN_TIMING_OUTCOMES.hit : RUN_TIMING_OUTCOMES.miss);
  // What gets recorded next to the sandbox id: the binding that actually
  // produced it, the retained sandbox's own, else a fresh one where the thread
  // asked to run. The fresh one is resolved only when nothing is retained, so a
  // collaborator's reply reuses the thread's sandbox wherever it lives instead of
  // being asked for a machine of their own.
  const binding = retained?.binding ?? (ctx.expectedSandbox
    ? await dependencies.bindingForThread(ctx.orgId ?? "", ctx.threadId ?? "", { expectedSandbox: ctx.expectedSandbox })
    : await dependencies.bindingForRun(ctx));
  let sandbox: SandboxHandle | null = retained?.sandbox ?? null;
  let reused = sandbox !== null;

  if (!sandbox) {
    await ctx.emit({ kind: "task", label: "Provisioning cloud sandbox…", chip: options.chip });
    if (binding.kind === "cube" && binding.credential === "env" && options.warmPool !== false) {
      const endWarmPool = ctx.timing?.begin(RUN_TIMING_STAGES.sandboxWarmPool);
      try {
        sandbox = await claimCubeWarmSandbox(options.warmPool || undefined);
        endWarmPool?.(sandbox ? RUN_TIMING_OUTCOMES.hit : RUN_TIMING_OUTCOMES.miss);
        if (sandbox) await noteLostWorkspace(ctx);
      } catch (error) {
        endWarmPool?.(RUN_TIMING_OUTCOMES.failure);
        throw error;
      }
      reused = sandbox !== null;
    }
    if (!sandbox) {
      const endCreate = ctx.timing?.begin(RUN_TIMING_STAGES.sandboxCreate);
      try {
        sandbox = (await provisionSandbox({
          ctx,
          binding,
          snapshot: snapshotForBinding(binding, options.snapshot),
          chip: options.chip,
          create: {
            labels: {
              ...providerGatewaySandboxLabels(ctx.runId),
              ...options.labels,
            },
            autoStopInterval: Number(process.env.SANDBOX_AUTO_STOP_MIN ?? 30),
            autoDeleteInterval: Number(process.env.SANDBOX_AUTO_DELETE_MIN ?? 4320),
          },
          resourceTarget,
        })).sandbox;
        endCreate?.(RUN_TIMING_OUTCOMES.success);
      } catch (error) {
        endCreate?.(RUN_TIMING_OUTCOMES.failure);
        throw error;
      }
    }
  }

  try {
    assertSandboxResources(sandbox, resourceTarget);
  } catch (error) {
    // A fresh box below the target is never retained; it would only fail again.
    if (!reused) await sandbox.delete().catch(() => {});
    throw error;
  }
  await persistSandboxBeforeExecution({
    runId: ctx.runId,
    sandboxId: sandbox.id,
    reused,
    persist: (runId, sandboxId) => dependencies.persist(runId, sandboxId, bindingRecord(binding)),
    deleteFreshSandbox: () => sandbox.delete(),
  });
  if (ctx.threadId) rememberLiveThreadSandbox(ctx.threadId, sandbox);
  return {
    sandbox,
    binding,
    reused,
    retained: Boolean(ctx.threadId),
    releaseAfterRun: !ctx.threadId,
  };
}
