import { backendFetch } from "@/lib/backend-fetch";
import {
  decodeRunnerPolicy,
  decodeRunners,
  type Runner,
  type RunnerPlatform,
  type RunnerPolicy,
} from "./runner-data";

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>;
const jsonHeaders = { "content-type": "application/json" } as const;

export async function fetchRunners(fetcher: Fetcher = backendFetch): Promise<Runner[]> {
  const response = await fetcher("/api/runners", { cache: "no-store" });
  if (!response.ok) throw new Error(`runners ${response.status}`);
  return decodeRunners(await response.json());
}

export async function enrolRunner(
  input: { readonly name: string; readonly platform: RunnerPlatform },
  fetcher: Fetcher = backendFetch,
): Promise<{ runnerId: string; token: string }> {
  const response = await fetcher("/api/runners/enrol", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error(`runner-enrol ${response.status}`);
  const value = (await response.json()) as { runnerId?: unknown; token?: unknown };
  if (typeof value.runnerId !== "string" || typeof value.token !== "string") {
    throw new Error("runner-enrol malformed response");
  }
  return { runnerId: value.runnerId, token: value.token };
}

export async function revokeRunner(id: string, fetcher: Fetcher = backendFetch): Promise<void> {
  const response = await fetcher(`/api/runners/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`runner-revoke ${response.status}`);
}

export async function fetchRunnerPolicy(fetcher: Fetcher = backendFetch): Promise<RunnerPolicy> {
  const response = await fetcher("/api/runners/policy", { cache: "no-store" });
  if (!response.ok) throw new Error(`runner-policy ${response.status}`);
  const policy = decodeRunnerPolicy(await response.json());
  if (!policy) throw new Error("runner-policy malformed response");
  return policy;
}

/** The deployment's sandbox provider and the name a person reads for it, from
 *  GET /api/config; fetched once per page and shared, since every run location
 *  on a page asks the same question. A failed read stays null and is retried
 *  on the next ask. */
export interface SandboxProviderName {
  readonly provider: string;
  readonly label: string;
}

let sandboxProviderNameRead: Promise<SandboxProviderName | null> | null = null;

export function fetchSandboxProviderName(fetcher: Fetcher = backendFetch): Promise<SandboxProviderName | null> {
  sandboxProviderNameRead ??= (async () => {
    try {
      const response = await fetcher("/api/config", { cache: "no-store" });
      if (!response.ok) throw new Error(`config ${response.status}`);
      const value = (await response.json()) as { sandbox?: { provider?: unknown; label?: unknown } };
      const provider = value.sandbox?.provider;
      const label = value.sandbox?.label;
      return typeof provider === "string" && typeof label === "string" && label ? { provider, label } : null;
    } catch {
      sandboxProviderNameRead = null;
      return null;
    }
  })();
  return sandboxProviderNameRead;
}

export async function fetchRunnerEnabled(fetcher: Fetcher = backendFetch): Promise<boolean> {
  const response = await fetcher("/api/config", { cache: "no-store" });
  if (!response.ok) throw new Error(`config ${response.status}`);
  const value = (await response.json()) as { runner?: { enabled?: unknown } };
  if (typeof value.runner?.enabled !== "boolean") throw new Error("config runner malformed response");
  return value.runner.enabled;
}

export async function updateRunnerPolicy(
  patch: Partial<RunnerPolicy>,
  fetcher: Fetcher = backendFetch,
): Promise<RunnerPolicy> {
  const response = await fetcher("/api/runners/policy", {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    const error = new Error(`runner-policy ${response.status}`);
    error.name = response.status === 403 ? "ForbiddenError" : "Error";
    throw error;
  }
  const policy = decodeRunnerPolicy(await response.json());
  if (!policy) throw new Error("runner-policy malformed response");
  return policy;
}

export async function canManageRunnerPolicy(
  organizationId: string,
  fetcher: Fetcher = backendFetch,
): Promise<boolean> {
  const roleResponse = await fetcher(
    `/api/auth/organization/get-active-member-role?organizationId=${encodeURIComponent(organizationId)}`,
    { cache: "no-store" },
  );
  if (!roleResponse.ok) return false;
  const body = (await roleResponse.json()) as { role?: unknown };
  return body.role === "owner" || body.role === "admin";
}
