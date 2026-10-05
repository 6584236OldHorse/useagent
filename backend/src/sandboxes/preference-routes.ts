import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { isSandboxProviderKind, sandboxPlugin } from "./plugins";
import { sandboxProviderKind } from "./provider";
import { enabledSandboxProviders, readSandboxPreference, writeSandboxPreference } from "./preference";

// /api/sandbox-preference - the signed-in member's preferred sandbox provider
// for new sandboxes, among the providers this deployment can run.
export const sandboxPreferenceRoutes = new Hono<AppEnv>();

sandboxPreferenceRoutes.use("*", orgScope);

async function view(scope: { readonly orgId: string; readonly userId: string }) {
  return {
    provider: await readSandboxPreference(scope),
    defaultProvider: sandboxProviderKind(),
    enabled: enabledSandboxProviders().map((kind) => ({ kind, label: sandboxPlugin(kind).label })),
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
  const body = (await c.req.json().catch(() => null)) as { provider?: unknown } | null;
  const provider = body?.provider ?? null;
  if (provider !== null && (typeof provider !== "string" || !isSandboxProviderKind(provider) || !enabledSandboxProviders().includes(provider))) {
    return c.json({ error: "provider_not_enabled", enabled: enabledSandboxProviders() }, 400);
  }
  const scope = { orgId: c.get("orgId"), userId };
  await writeSandboxPreference(scope, provider);
  return c.json(await view(scope));
});
