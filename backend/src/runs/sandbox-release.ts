import { SandboxNotFoundError } from "@useagent/sandbox-contract";
import type { Hono } from "hono";
import type { AppEnv } from "../http";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { runs } from "../db/schema";
import { type SandboxProvider } from "../sandboxes/provider";
import { forgetLiveThreadSandbox } from "../engines/sandbox-runtime";
import { piBridgeManager } from "../engines/pi-rpc-bridge";
import {
  clearThreadSandbox,
  getRunForOrg,
  getThreadSandboxForOrg,
  threadHasActiveRuns,
} from "./repo";
import { withThreadLifecycleLock } from "./thread-lifecycle-lock";
import { parseProviderSessionBinding } from "@useagent/agent-harness/canonical";
import {
  ExpectedSandboxMismatchError,
  PersonalSandboxConnectionUnavailableError,
  getThreadExpectedSandbox,
  resolveSandboxBindingForSandbox,
  resolveSandboxBindingForThread,
} from "../sandboxes/binding";
import {
  parseExpectedSandboxBinding,
  type ExpectedSandboxBinding,
} from "../sandboxes/expected-binding";

export type SandboxReleaseResult =
  | { ok: true; released: false; reason: "no_sandbox" }
  | { ok: true; released: false; reason: "connection_revoked"; sandboxId: string }
  | { ok: true; released: true; sandboxId: string }
  | { ok: false; reason: "not_found" | "thread_active" | "provider_error" | "expected_sandbox_mismatch" };

interface SandboxReleaseDeps {
  readonly provider?: SandboxProvider;
  readonly removePiBridge?: (
    sessionFile: string,
    expectedSandbox?: ExpectedSandboxBinding,
  ) => Promise<void>;
  readonly expectedSandboxId?: string;
}

/**
 * Explicitly release a settled thread's sandbox.
 *
 * Normal product threads stay warm for fast resume. Test/eval callers use this
 * endpoint when they are done, avoiding a fleet leak without weakening normal
 * retention. The durable mapping is cleared only after provider deletion (or an
 * authoritative provider listing proves the sandbox is already absent).
 */
export async function releaseRunSandbox(
  orgId: string,
  runId: string,
  deps: SandboxReleaseDeps = {},
): Promise<SandboxReleaseResult> {
  const run = await getRunForOrg(orgId, runId);
  if (!run) return { ok: false, reason: "not_found" };

  const released = await withThreadLifecycleLock(orgId, run.threadId, async (tx) => {
    const lockedRun = await getRunForOrg(orgId, runId, tx);
    if (!lockedRun) return { ok: false as const, reason: "not_found" as const };
    if (await threadHasActiveRuns(orgId, lockedRun.threadId, tx)) {
      return { ok: false as const, reason: "thread_active" as const };
    }
    const expectedSandbox = parseExpectedSandboxBinding(lockedRun.expectedSandbox) ??
      await getThreadExpectedSandbox(orgId, lockedRun.threadId, tx);
    const sandboxId = await getThreadSandboxForOrg(orgId, lockedRun.threadId, tx);
    if (
      (deps.expectedSandboxId !== undefined && deps.expectedSandboxId !== sandboxId) ||
      (expectedSandbox && expectedSandbox.sandboxId !== sandboxId)
    ) {
      return { ok: false as const, reason: "expected_sandbox_mismatch" as const };
    }
    if (!sandboxId) return { ok: true as const, released: false as const, reason: "no_sandbox" as const };

    let provider: SandboxProvider;
    try {
      provider = expectedSandbox
        ? (await resolveSandboxBindingForThread(orgId, lockedRun.threadId, { expectedSandbox })).provider
        : deps.provider ?? (await resolveSandboxBindingForSandbox(sandboxId)).provider;
    } catch (error) {
      if (expectedSandbox && (
        error instanceof ExpectedSandboxMismatchError ||
        error instanceof PersonalSandboxConnectionUnavailableError
      )) {
        return { ok: false as const, reason: "expected_sandbox_mismatch" as const };
      }
      if (!(error instanceof PersonalSandboxConnectionUnavailableError)) {
        return { ok: false as const, reason: "provider_error" as const };
      }
      // The personal connection that created it is gone: nothing can delete it, but the
      // thread must not stay pinned to an unreachable sandbox.
      const cleared = await clearThreadSandbox(orgId, lockedRun.threadId, sandboxId, tx);
      if (cleared === 0) return { ok: false as const, reason: "provider_error" as const };
      return { ok: true as const, released: false as const, reason: "connection_revoked" as const, sandboxId };
    }
    if (expectedSandbox) {
      try {
        const sandbox = await provider.get(sandboxId);
        if (sandbox.id !== sandboxId) throw new ExpectedSandboxMismatchError();
        await sandbox.delete();
      } catch (error) {
        if (error instanceof ExpectedSandboxMismatchError) {
          return { ok: false as const, reason: "expected_sandbox_mismatch" as const };
        }
        if (!(error instanceof SandboxNotFoundError)) {
          return { ok: false as const, reason: "provider_error" as const };
        }
      }
    } else {
      try {
        const sandbox = await provider.get(sandboxId);
        if (sandbox.id !== sandboxId) throw new Error("provider returned a different sandbox");
        await sandbox.delete();
      } catch {
        const live = new Set<string>();
        try {
          for await (const sandbox of provider.list()) live.add(sandbox.id);
        } catch {
          return { ok: false as const, reason: "provider_error" as const };
        }
        if (live.has(sandboxId)) return { ok: false as const, reason: "provider_error" as const };
      }
    }

    const [threadSession] = expectedSandbox
      ? await tx.select({
          engine: runs.engine,
          engineSessionId: runs.engineSessionId,
          providerSession: runs.providerSession,
        }).from(runs).where(and(
          eq(runs.orgId, orgId),
          eq(runs.threadId, lockedRun.threadId),
          isNotNull(runs.engineSessionId),
        )).orderBy(desc(runs.createdAt), desc(runs.id)).limit(1)
      : [];
    const cleared = await clearThreadSandbox(orgId, lockedRun.threadId, sandboxId, tx);
    if (cleared === 0) return { ok: false as const, reason: "provider_error" as const };
    return {
      ok: true as const,
      released: true as const,
      sandboxId,
      threadId: lockedRun.threadId,
      engine: threadSession ? threadSession.engine : lockedRun.engine,
      engineSessionId: threadSession ? threadSession.engineSessionId : lockedRun.engineSessionId,
      providerSession: threadSession ? threadSession.providerSession : lockedRun.providerSession,
      expectedSandbox,
    };
  });

  if (released.ok && released.released) {
    forgetLiveThreadSandbox(released.threadId, released.sandboxId);
    const binding = parseProviderSessionBinding(released.providerSession);
    const piSessionId = binding?.provider === "pi"
      ? binding.nativeSessionId
      : released.engine === "pi"
        ? released.engineSessionId
        : null;
    if (piSessionId) {
      const removePiBridge = deps.removePiBridge ?? ((sessionFile, expectedSandbox) =>
        piBridgeManager.remove(sessionFile, expectedSandbox));
      await removePiBridge(piSessionId, released.expectedSandbox ?? undefined).catch((error) => {
        console.warn("[sandbox-release] failed to remove Pi bridge", {
          runId,
          error: error instanceof Error ? error.message : "unknown error",
        });
      });
    }
    return { ok: true, released: true, sandboxId: released.sandboxId };
  }
  return released;
}

/** Explicit cleanup; product threads remain warm until this org-scoped request. */
export function registerSandboxReleaseRoute(routes: Hono<AppEnv>): void {
  routes.delete("/:id/sandbox", async (c) => {
    const result = await releaseRunSandbox(c.get("orgId"), c.req.param("id"));
    if (!result.ok) {
      if (result.reason === "not_found") return c.json({ error: "run not found" }, 404);
      if (result.reason === "thread_active") return c.json({ error: "thread is active" }, 409);
      return c.json({ error: "sandbox release failed" }, 502);
    }
    return c.json(result);
  });
}
