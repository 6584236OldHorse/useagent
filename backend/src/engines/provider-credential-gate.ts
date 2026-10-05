import type { EngineId } from "../db/schema";
import {
  credentialWaitSignal,
  resolveProviderCredentialForRun,
  type ProviderCredentialResolvers,
} from "../provider-gateway/credentials";
import { awaitWithSignal } from "../util/abortable-operation";
import { PROVIDER_DISPLAY_NAMES, providerForEngine, type ProviderId } from "../provider-gateway/provider";
import { engineAuthMode } from "../runs/engine-auth-mode";
import { ENGINE_DISPLAY_NAMES } from "../runs/engine-readiness";
import { defaultModelForEngine } from "../runs/model-policy";
import type { EngineRunContext } from "./types";
import { getCodexSubscriptionRuntimeSelection } from "../provider-connections/service";

/** Thrown when no key can serve the run; the message is the remedy. */
export class ProviderCredentialMissingError extends Error {}

export function providerCredentialMissingMessage(engine: string, provider: ProviderId): string {
  const engineLabel = (ENGINE_DISPLAY_NAMES as Record<string, string | undefined>)[engine] ?? engine;
  const providerLabel = PROVIDER_DISPLAY_NAMES[provider];
  return `${engineLabel} cannot start: no ${providerLabel} key is connected for this organization. ` +
    `Connect an ${providerLabel} key in Settings, then retry.`;
}

/** Resolve the credential the provider gateway would use for this run's first
 * model call BEFORE any sandbox is provisioned. A missing key then fails the
 * run in milliseconds with the remedy instead of after a paid boot and an
 * upstream 401. Engines on a subscription or hybrid auth path carry their own
 * credential and are left alone. Every read runs on the run's own clock
 * (credentialWaitSignal), so Stop and a deadline both end a blocked read. */
export async function assertRunProviderCredential(
  engine: string,
  ctx: Pick<EngineRunContext, "orgId" | "userId" | "model"> & { readonly signal?: AbortSignal },
  deps: ProviderCredentialResolvers & {
    readonly resolve?: typeof resolveProviderCredentialForRun;
    readonly resolveSubscription?: typeof getCodexSubscriptionRuntimeSelection;
  } = {},
): Promise<void> {
  if (!ctx.orgId) return;
  const { orgId, userId } = ctx;
  const env = deps.env ?? process.env;
  const engineId = engine as EngineId;
  const authMode = engineAuthMode(engineId, env);
  if (!authMode) return;
  const signal = credentialWaitSignal(ctx.signal);
  if (engineId === "codex" && (authMode === "subscription" || authMode === "hybrid")) {
    const subscription = userId
      ? await awaitWithSignal(
          () => (deps.resolveSubscription ?? getCodexSubscriptionRuntimeSelection)({ orgId, userId }),
          signal,
        )
      : null;
    if (subscription) return;
    if (authMode === "subscription") {
      throw new Error(
        "Codex cannot start: no connected Codex account is available for this user. " +
          "Connect the account in Settings, then retry.",
      );
    }
  } else if (authMode !== "provider_gateway") {
    return;
  }
  const model = ctx.model?.trim() || defaultModelForEngine(engineId, env);
  const provider = providerForEngine(engineId, model);
  if (!provider) return;
  const resolve = deps.resolve ?? resolveProviderCredentialForRun;
  const resolved = await awaitWithSignal(
    () => resolve({ orgId, userId, provider, model }, deps),
    signal,
  );
  if (resolved) return;
  throw new ProviderCredentialMissingError(providerCredentialMissingMessage(engine, provider));
}
