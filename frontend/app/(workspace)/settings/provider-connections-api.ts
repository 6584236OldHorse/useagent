import { backendFetch } from "@/lib/backend-fetch";
import {
  type CodexChatGptLogin,
  type CodexChatGptStatus,
  type ProviderConnectionAuthMethod,
  type ProviderConnectionMeta,
  type ProviderConnectionMetadata,
  type ProviderConnectionProvider,
  safeCodexChatGptLogin,
  safeCodexChatGptStatus,
  safeCodexRateLimits,
  type CodexRateLimits,
  safeDeploymentProviders,
  safeEnabledSandboxEngines,
  safeProviderConnectionMeta,
  safeProviderConnections,
} from "./provider-connections-data";

const jsonHeaders = { "content-type": "application/json" } as const;

export async function fetchProviderConnections(): Promise<ProviderConnectionMeta[]> {
  const res = await backendFetch("/api/provider-connections", { cache: "no-store" });
  if (!res.ok) throw new Error(`provider-connections ${res.status}`);
  const data = (await res.json()) as { connections?: unknown };
  return safeProviderConnections(data.connections);
}

export interface SandboxConfig {
  readonly provider: string | null;
  /** The provider's name as a person reads it, from where the deployment points
   *  (the E2B-protocol plugin is "E2B" on e2b.app and "Cube" self-hosted). */
  readonly label: string | null;
  /** The host the managed sandboxes run on, when the server says. */
  readonly host: string | null;
  /** True when a connected personal computer runs that user's work. */
  readonly userComputers: boolean;
}

/** Where the deployment's sandboxes come from. Operator-only: the Infrastructure
 *  section is the one caller, and it renders for operator accounts alone. */
export async function fetchSandboxConfig(): Promise<SandboxConfig> {
  const res = await backendFetch("/api/operator/sandbox", { cache: "no-store" });
  if (!res.ok) throw new Error(`sandbox-config ${res.status}`);
  const data = (await res.json()) as { provider?: unknown; label?: unknown; host?: unknown; userComputers?: unknown };
  return {
    provider: typeof data.provider === "string" ? data.provider : null,
    label: typeof data.label === "string" && data.label ? data.label : null,
    host: typeof data.host === "string" && data.host ? data.host : null,
    userComputers: data.userComputers === true,
  };
}

export interface DeploymentConfig {
  readonly enabledSandboxEngines: string[];
  readonly deploymentProviders: Partial<Record<ProviderConnectionProvider, boolean>>;
  /** Providers this account is offered, when the server restricts any (PROVIDER_ACCOUNTS);
   *  null when the manifest carries no list, meaning every provider. */
  readonly offeredProviders: string[] | null;
}

/** The parts of GET /api/config the provider settings read: which sandbox
 *  engines run here, and which providers the deployment serves from its own keys. */
export async function fetchDeploymentConfig(): Promise<DeploymentConfig> {
  const res = await backendFetch("/api/config", { cache: "no-store" });
  if (!res.ok) throw new Error(`deployment-config ${res.status}`);
  const data = (await res.json()) as { engines?: unknown; providers?: unknown; offeredProviders?: unknown };
  return {
    enabledSandboxEngines: safeEnabledSandboxEngines(data.engines),
    deploymentProviders: safeDeploymentProviders(data.providers),
    offeredProviders: Array.isArray(data.offeredProviders)
      ? data.offeredProviders.filter((item): item is string => typeof item === "string")
      : null,
  };
}

export async function putProviderApiKey(input: {
  provider: ProviderConnectionProvider;
  apiKey: string;
  metadata?: ProviderConnectionMetadata;
}): Promise<ProviderConnectionMeta> {
  const res = await backendFetch(
    `/api/provider-connections/${encodeURIComponent(input.provider)}/api-key`,
    {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify({
        apiKey: input.apiKey,
        metadata: input.metadata ?? {},
      }),
    },
  );
  if (!res.ok) throw new Error(`provider-api-key ${res.status}`);
  const data = (await res.json()) as { connection?: unknown };
  const connection = safeProviderConnectionMeta(data.connection);
  if (!connection) throw new Error("provider-api-key missing connection");
  return connection;
}

export async function revokeProviderConnection(input: {
  provider: ProviderConnectionProvider;
  authMethod: ProviderConnectionAuthMethod;
}): Promise<ProviderConnectionMeta> {
  const res = await backendFetch(
    `/api/provider-connections/${encodeURIComponent(
      input.provider,
    )}/revoke?authMethod=${encodeURIComponent(input.authMethod)}`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`provider-revoke ${res.status}`);
  const data = (await res.json()) as { connection?: unknown };
  const connection = safeProviderConnectionMeta(data.connection);
  if (!connection) throw new Error("provider-revoke missing connection");
  return connection;
}

export async function startCodexChatGptLogin(): Promise<CodexChatGptLogin> {
  const res = await backendFetch("/api/provider-connections/openai/chatgpt-oauth/start", {
    method: "POST",
  });
  if (!res.ok) throw new Error(`codex-chatgpt-start ${res.status}`);
  const data = (await res.json()) as { login?: unknown };
  const login = safeCodexChatGptLogin(data.login);
  if (!login) throw new Error("codex-chatgpt-start missing login");
  return login;
}

/** Null when no ChatGPT account is signed in for the current user. */
export async function fetchCodexRateLimits(): Promise<CodexRateLimits | null> {
  const res = await backendFetch("/api/provider-connections/openai/chatgpt-oauth/limits", {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`codex-rate-limits ${res.status}`);
  const data = (await res.json()) as { limits?: unknown };
  return safeCodexRateLimits(data.limits);
}

export async function fetchCodexChatGptStatus(): Promise<CodexChatGptStatus> {
  const res = await backendFetch("/api/provider-connections/openai/chatgpt-oauth/status", {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`codex-chatgpt-status ${res.status}`);
  const data = (await res.json()) as { status?: unknown };
  const status = safeCodexChatGptStatus(data.status);
  if (!status) throw new Error("codex-chatgpt-status missing status");
  return status;
}

export async function cancelCodexChatGptLogin(input: {
  loginId: string;
}): Promise<{ status: string }> {
  const res = await backendFetch("/api/provider-connections/openai/chatgpt-oauth/cancel", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ loginId: input.loginId }),
  });
  if (!res.ok) throw new Error(`codex-chatgpt-cancel ${res.status}`);
  const data = (await res.json()) as { status?: unknown };
  if (typeof data.status !== "string") throw new Error("codex-chatgpt-cancel missing status");
  return { status: data.status };
}

export async function revokeCodexChatGptLogin(): Promise<ProviderConnectionMeta> {
  const res = await backendFetch("/api/provider-connections/openai/chatgpt-oauth/revoke", {
    method: "POST",
  });
  if (!res.ok) throw new Error(`codex-chatgpt-revoke ${res.status}`);
  const data = (await res.json()) as { connection?: unknown };
  const connection = safeProviderConnectionMeta(data.connection);
  if (!connection) throw new Error("codex-chatgpt-revoke missing connection");
  return connection;
}
