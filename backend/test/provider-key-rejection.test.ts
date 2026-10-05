import { afterAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { db } from "../src/db/client";
import { applyGatewayGrants, GATEWAY_DATABASE_ROLE } from "../src/db/gateway-grants";
import { providerConnections } from "../src/db/schema";
import {
  markGatewayProviderApiKeyRejected,
  resolveGatewayProviderApiKeyCredential,
} from "../src/provider-gateway/api-key-credentials";
import { upsertApiKeyProviderConnection } from "../src/provider-connections/service";
import { testDatabaseUrl } from "./test-database";
import "./helpers"; // boots src/index -> migrate

// A member's key the provider rejected, marked by the RESTRICTED gateway role
// through its credentials view, as production runs it.

const adminUrl = new URL(testDatabaseUrl());
const gatewayUrl = new URL(testDatabaseUrl());
gatewayUrl.username = GATEWAY_DATABASE_ROLE;
gatewayUrl.password = "";
const admin = postgres(adminUrl.toString(), { max: 1 });
const asGateway = postgres(gatewayUrl.toString(), { max: 1 });

afterAll(async () => {
  await admin.end({ timeout: 2 }).catch(() => undefined);
  await asGateway.end({ timeout: 2 }).catch(() => undefined);
});

test("a rejected member key needs reconnect until a new key is saved", async () => {
  await admin.unsafe(
    `do $$ begin if not exists (select 1 from pg_roles where rolname = '${GATEWAY_DATABASE_ROLE}') then create role ${GATEWAY_DATABASE_ROLE} login; end if; end $$`,
  );
  await applyGatewayGrants(admin);
  const scope = { orgId: `key-rejection-${crypto.randomUUID()}`, userId: `user-${crypto.randomUUID()}` };
  const key = { ...scope, provider: "openrouter" } as const;
  const row = async () => {
    const [found] = await db
      .select({ status: providerConnections.status, statusReason: providerConnections.statusReason })
      .from(providerConnections)
      .where(and(eq(providerConnections.orgId, scope.orgId), eq(providerConnections.userId, scope.userId)));
    return found;
  };

  await upsertApiKeyProviderConnection({ ...key, apiKey: "sk-old", metadata: {} });
  // Only the key that was sent can be marked.
  expect(await markGatewayProviderApiKeyRejected({ ...key, value: "sk-other", status: 401 }, asGateway)).toBe(false);
  expect(await row()).toEqual({ status: "connected", statusReason: null });

  expect(await markGatewayProviderApiKeyRejected({ ...key, value: "sk-old", status: 401 }, asGateway)).toBe(true);
  expect(await row()).toEqual({ status: "reauth_required", statusReason: "provider_rejected_401" });
  expect(await resolveGatewayProviderApiKeyCredential(key)).toBeNull();

  // Saving a new key restores Connected, and a late rejection of the old key
  // cannot mark the new one.
  await upsertApiKeyProviderConnection({ ...key, apiKey: "sk-new", metadata: {} });
  expect(await row()).toEqual({ status: "connected", statusReason: null });
  expect(await markGatewayProviderApiKeyRejected({ ...key, value: "sk-old", status: 401 }, asGateway)).toBe(false);
  expect(await row()).toEqual({ status: "connected", statusReason: null });
  expect(await resolveGatewayProviderApiKeyCredential(key)).toBe("sk-new");

  // The role still cannot touch the credential itself.
  let denied: unknown = null;
  try {
    await asGateway.unsafe(
      `update gateway_provider_api_key_credentials set credential_ciphertext = 'x' where org_id = '${scope.orgId}'`,
    );
  } catch (error) {
    denied = error;
  }
  expect(String((denied as Error | null)?.message ?? "")).toMatch(/permission denied/);
}, 20_000);
