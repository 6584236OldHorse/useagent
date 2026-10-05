import { client } from "../db/client";
import type {
  ProviderConnectionMetadata,
  ProviderConnectionProvider,
} from "../db/schema";
import { openSecret } from "../secrets/crypto";
import { awaitWithSignal } from "../util/abortable-operation";
import type { ProviderId } from "./provider";

/** How long marking a rejected key may hold the failing turn. */
const REJECTED_KEY_WRITE_MS = 5_000;

export interface GatewayProviderApiKeyCredentialRow {
  readonly auth_method: string;
  readonly status: string;
  readonly credential_ciphertext: string;
  readonly iv: string;
  readonly tag: string;
}

export interface GatewayComputerApiKeyCredentialRow
  extends GatewayProviderApiKeyCredentialRow {
  readonly provider: ProviderConnectionProvider;
  readonly metadata: ProviderConnectionMetadata | null;
  /** A Date from the driver, or the ISO/SQL text the restricted view yields. */
  readonly updated_at: Date | string;
}

export interface GatewayComputerApiKeyConnection {
  readonly provider: ProviderConnectionProvider;
  readonly value: string;
  readonly metadata: ProviderConnectionMetadata;
  readonly updatedAt: string;
}

/** The connection a computer row resolves to; null when the credential is not an open API key. */
export function gatewayComputerApiKeyConnectionFromRow(
  row: GatewayComputerApiKeyCredentialRow,
): GatewayComputerApiKeyConnection | null {
  const value = openGatewayProviderApiKeyCredential(row);
  if (!value) return null;
  const updatedAt = row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at);
  if (Number.isNaN(updatedAt.getTime())) {
    throw new Error("Computer credential timestamp is invalid");
  }
  return {
    provider: row.provider,
    value,
    metadata: row.metadata ?? {},
    updatedAt: updatedAt.toISOString(),
  };
}

export function openGatewayProviderApiKeyCredential(
  row: GatewayProviderApiKeyCredentialRow,
): string | null {
  if (row.auth_method !== "api_key" || row.status !== "connected") return null;
  try {
    const credential = JSON.parse(
      openSecret({
        ciphertext: row.credential_ciphertext,
        iv: row.iv,
        tag: row.tag,
      }),
    ) as unknown;
    if (
      !credential ||
      typeof credential !== "object" ||
      Array.isArray(credential) ||
      !("authMethod" in credential) ||
      credential.authMethod !== "api_key" ||
      !("value" in credential) ||
      typeof credential.value !== "string"
    ) {
      return null;
    }
    return credential.value.trim() || null;
  } catch {
    return null;
  }
}

export async function resolveGatewayProviderApiKeyCredential(input: {
  readonly orgId: string;
  readonly userId: string;
  readonly provider: ProviderId;
}): Promise<string | null> {
  const rows = await client<GatewayProviderApiKeyCredentialRow[]>`
    SELECT auth_method, status, credential_ciphertext, iv, tag
    FROM gateway_provider_api_key_credentials
    WHERE org_id = ${input.orgId}
      AND user_id = ${input.userId}
      AND provider = ${input.provider}
      AND auth_method = 'api_key'
      AND status = 'connected'
    LIMIT 1
  `;
  const row = rows[0];
  return row ? openGatewayProviderApiKeyCredential(row) : null;
}

/** Mark a member's connected API key as reauth_required after the provider
 * rejected it. Only the exact key that was sent: a key saved since is a new
 * sealed credential (new iv) and stays connected. The reason is the HTTP
 * status alone, never the provider's answer. Writes through the restricted
 * view, so the gateway role can only move a connected key out of it. Bounded
 * and never throws: a failed write must not change how the turn fails. */
export async function markGatewayProviderApiKeyRejected(
  input: {
    readonly orgId: string;
    readonly userId: string;
    readonly provider: ProviderId;
    readonly value: string;
    readonly status: number;
  },
  sql: typeof client = client,
): Promise<boolean> {
  try {
    return await awaitWithSignal(async () => {
      const [row] = await sql<GatewayProviderApiKeyCredentialRow[]>`
        SELECT auth_method, status, credential_ciphertext, iv, tag
        FROM gateway_provider_api_key_credentials
        WHERE org_id = ${input.orgId}
          AND user_id = ${input.userId}
          AND provider = ${input.provider}
          AND auth_method = 'api_key'
          AND status = 'connected'
        LIMIT 1
      `;
      if (!row || openGatewayProviderApiKeyCredential(row) !== input.value) return false;
      const updated = await sql`
        UPDATE gateway_provider_api_key_credentials
        SET status = 'reauth_required',
          status_reason = ${`provider_rejected_${input.status}`},
          updated_at = now()
        WHERE org_id = ${input.orgId}
          AND user_id = ${input.userId}
          AND provider = ${input.provider}
          AND auth_method = 'api_key'
          AND iv = ${row.iv}
      `;
      return updated.count > 0;
    }, AbortSignal.timeout(REJECTED_KEY_WRITE_MS));
  } catch (error) {
    console.warn(
      `[provider-key] could not mark the rejected ${input.provider} key:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

/** Resolve the most recently updated connected computer credential through the
 * restricted API-key view. The gateway never reads the underlying table
 * directly; metadata is non-secret and the credential remains sealed until
 * this exact org/user lookup succeeds. */
export async function resolveGatewayComputerApiKeyConnection(input: {
  readonly orgId: string;
  readonly userId: string;
  readonly providers: readonly ProviderConnectionProvider[];
}): Promise<GatewayComputerApiKeyConnection | null> {
  if (input.providers.length === 0) return null;
  const rows = await client<GatewayComputerApiKeyCredentialRow[]>`
    SELECT provider, auth_method, status, credential_ciphertext, iv, tag, metadata, updated_at
    FROM gateway_provider_api_key_credentials
    WHERE org_id = ${input.orgId}
      AND user_id = ${input.userId}
      AND provider = ANY(${[...input.providers]})
      AND auth_method = 'api_key'
      AND status = 'connected'
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  return row ? gatewayComputerApiKeyConnectionFromRow(row) : null;
}
