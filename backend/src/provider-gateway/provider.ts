import type { EngineId } from "../db/schema";
import { runtimeDevModeEnabled } from "../security/runtime-secrets";

export const PROVIDER_IDS = ["anthropic", "openai", "openrouter", "cerebras", "opencode"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_DISPLAY_NAMES: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  cerebras: "Cerebras",
  opencode: "OpenCode Zen",
};

/** OpenCode Zen's own model id for one of our "opencode/<id>:free" lane ids:
 * the lane marks free models with ":free" (OpenRouter's convention); Zen's ids
 * carry no marker. */
export function openCodeZenModelId(model: string): string {
  return model.slice("opencode/".length).replace(/:free$/, "");
}

export function providerForEngine(engine: EngineId, model: string): ProviderId | null {
  switch (engine) {
    case "opencode":
    case "daytona":
    case "pi":
      if (model.startsWith("openai/")) return "openai";
      if (model.startsWith("cerebras/")) return "cerebras";
      if (model.startsWith("opencode/")) return "opencode";
      return model.includes("/") ? "openrouter" : "anthropic";
    case "claude":
    case "claude-sdk":
      return "anthropic";
    case "codex":
      return "openai";
    case "chat":
      return "openrouter";
    case "mock":
      return null;
  }
}

export function providerCredentialName(provider: ProviderId): string {
  switch (provider) {
    case "anthropic":
      return "ANTHROPIC_API_KEY";
    case "openai":
      return "OPENAI_API_KEY";
    case "openrouter":
      return "OPENROUTER_API_KEY";
    case "cerebras":
      return "CEREBRAS_API_KEY";
    case "opencode":
      return "OPENCODE_API_KEY";
  }
}

/** Which model providers this deployment serves a member's run from its own
 *  keys, by the same rule as resolveProviderCredentialForRun: a house key
 *  serves runs only in dev mode, except the Zen key that runs the free Zen
 *  lane everywhere. A key held for other work (wiki, distill) is not served.
 *  A provider NAME is not a secret; the value never leaves the server. */
export function deploymentProvidedProviders(
  env: Record<string, string | undefined> = process.env,
): Record<ProviderId, boolean> {
  const devMode = runtimeDevModeEnabled(env);
  return Object.fromEntries(
    PROVIDER_IDS.map((provider) => [
      provider,
      (devMode || provider === "opencode") && Boolean(env[providerCredentialName(provider)]?.trim()),
    ]),
  ) as Record<ProviderId, boolean>;
}
