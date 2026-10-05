import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { operatorOnly } from "../operator/access";
import { isSandboxProviderKind } from "./plugins";
import { sandboxProviderKind, sandboxProviderLabel } from "./provider";
import { enabledSandboxProviders, readSandboxPreference, writeSandboxPreference } from "./preference";

// /api/sandbox-preference - the preferred sandbox provider for new sandboxes,
// among the providers this deployment can run. It names vendors, so only an
// operator account reaches it; a stored preference keeps applying to runs.
export const sandboxPreferenceRoutes = new Hono<AppEnv>();

sandboxPreferenceRoutes.use("*", orgScope, operatorOnly);

async function view(scope: { readonly orgId: string; readonly userId: string }) {
  const enabled = enabledSandboxProviders();
  const stored = await readSandboxPreference(scope);
  return {
    // A stored vendor whose credential was removed since is not what runs; say so.
    provider: stored && enabled.includes(stored) ? stored : null,
    defaultProvider: sandboxProviderKind(),
    enabled: enabled.map((kind) => ({ kind, label: sandboxProviderLabel(kind) })),
  };
}

sandboxPreferenceRoutes.get("/", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "user_required" }, 403);
  return c.json(await view({ orgId: c.get("orgId"), userId }));
});

sandboxPreferenceRoutes.put("/", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "user_required" }, 403);
  const body = (await c.req.json().catch(() => null)) as unknown;
  // Only an explicit `provider` (a kind, or null to clear) may change the stored choice.
  if (!body || typeof body !== "object" || Array.isArray(body) || !("provider" in body)) {
    return c.json({ error: "invalid_body" }, 400);
  }
  const provider = (body as { provider: unknown }).provider;
  if (provider !== null && (typeof provider !== "string" || !isSandboxProviderKind(provider) || !enabledSandboxProviders().includes(provider))) {
    return c.json({ error: "provider_not_enabled", enabled: enabledSandboxProviders() }, 400);
  }
  const scope = { orgId: c.get("orgId"), userId };
  await writeSandboxPreference(scope, provider);
  return c.json(await view(scope));
});
