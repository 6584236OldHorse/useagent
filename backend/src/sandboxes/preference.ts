import type { SandboxEnv, SandboxProviderKind } from "@useagent/sandbox-contract";
import { and, eq } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { sandboxPreferences } from "../db/schema";
import { SANDBOX_PROVIDER_KINDS, sandboxPlugin } from "./plugins";
import { sandboxProviderKind } from "./provider";

/**
 * A member's preferred hosted provider for NEW sandboxes (Settings >
 * Infrastructure). It applies among the providers this deployment can run:
 * the default one plus every vendor whose credential variable is set. A
 * preference for anything else falls back to the deployment default, and a
 * thread's retained sandbox stays on the provider that made it.
 */

export interface SandboxPreferenceScope {
  readonly orgId: string;
  readonly userId: string;
}

/** Hosted providers a member may pick from. A machine is chosen per run from
 *  the runners a user enrolled, never here. */
export function enabledSandboxProviders(env: SandboxEnv = process.env): SandboxProviderKind[] {
  const fallback = sandboxProviderKind(env);
  return SANDBOX_PROVIDER_KINDS.filter(
    (kind) => kind !== "local" && (kind === fallback || Boolean(env[sandboxPlugin(kind).credentialEnv]?.trim())),
  );
}

export async function readSandboxPreference(
  scope: SandboxPreferenceScope,
  exec: Executor = db,
): Promise<SandboxProviderKind | null> {
  const [row] = await exec
    .select({ provider: sandboxPreferences.provider })
    .from(sandboxPreferences)
    .where(and(eq(sandboxPreferences.orgId, scope.orgId), eq(sandboxPreferences.userId, scope.userId)))
    .limit(1);
  return row?.provider ?? null;
}

/** Store the preference, or clear it with null (back to the deployment default). */
export async function writeSandboxPreference(
  scope: SandboxPreferenceScope,
  provider: SandboxProviderKind | null,
): Promise<void> {
  const where = and(eq(sandboxPreferences.orgId, scope.orgId), eq(sandboxPreferences.userId, scope.userId));
  if (provider === null) {
    await db.delete(sandboxPreferences).where(where);
    return;
  }
  await db
    .insert(sandboxPreferences)
    .values({ orgId: scope.orgId, userId: scope.userId, provider })
    .onConflictDoUpdate({
      target: [sandboxPreferences.orgId, sandboxPreferences.userId],
      set: { provider, updatedAt: new Date() },
    });
}
