import { Hono } from "hono";

import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { userComputersEnabled } from "../sandboxes/binding";
import { sandboxProviderKind, sandboxProviderLabel } from "../sandboxes/provider";
import { operatorOnly } from "./access";

/** Where the managed sandboxes run; only the E2B-protocol plugin has a configurable host. */
function managedSandboxHost(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  if (sandboxProviderKind(env) !== "cube") return null;
  return env.CUBE_SANDBOX_DOMAIN?.trim().toLowerCase() || null;
}

/** What the operator's Infrastructure section reads; 404 for everyone else. */
export const operatorRoutes = new Hono<AppEnv>();
operatorRoutes.use("*", orgScope, operatorOnly);

// The frontend asks this before rendering anything that names a sandbox vendor.
operatorRoutes.get("/access", (c) => c.json({ ok: true }));

// The deployment's sandbox vendor as a person reads it, and the host it points at.
operatorRoutes.get("/sandbox", (c) => {
  const provider = sandboxProviderKind();
  return c.json({
    provider,
    label: sandboxProviderLabel(provider),
    host: managedSandboxHost(),
    userComputers: userComputersEnabled(),
  });
});
