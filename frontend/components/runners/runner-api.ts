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
  userId: string,
  organizationId: string,
  fetcher: Fetcher = backendFetch,
): Promise<boolean> {
  const membersResponse = await fetcher(
    `/api/auth/organization/list-members?organizationId=${encodeURIComponent(organizationId)}`,
    { cache: "no-store" },
  );
  if (!membersResponse.ok) return false;
  const body = (await membersResponse.json()) as { members?: unknown };
  if (!Array.isArray(body.members)) return false;
  const membership = body.members.find(
    (value) =>
      value && typeof value === "object" && (value as { userId?: unknown }).userId === userId,
  ) as { role?: unknown } | undefined;
  return membership?.role === "owner" || membership?.role === "admin";
}
