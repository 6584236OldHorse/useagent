import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  openGatewayProviderApiKeyCredential,
  type GatewayProviderApiKeyCredentialRow,
} from "./api-key-credentials";
import {
  resolveChatProviderCredential,
  resolveProviderCredential,
  resolveProviderCredentialForRun,
  type ProviderCredentialResolvers,
} from "./credentials";
import { sealSecret } from "../secrets/crypto";

const encryptionKey = "provider-credential-test-encryption-root-0123456789";

let previousEncryptionKey: string | undefined;
let previousDevMode: string | undefined;

beforeEach(() => {
  previousEncryptionKey = process.env.SECRETS_ENCRYPTION_KEY;
  previousDevMode = process.env.USEAGENT_DEV_MODE;
  process.env.SECRETS_ENCRYPTION_KEY = encryptionKey;
});

afterEach(() => {
  if (previousEncryptionKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = previousEncryptionKey;
  if (previousDevMode === undefined) delete process.env.USEAGENT_DEV_MODE;
  else process.env.USEAGENT_DEV_MODE = previousDevMode;
});

/** A sealed provider_connections row exactly as the restricted view returns it. */
function sealedRow(
  value: unknown,
  overrides: Partial<GatewayProviderApiKeyCredentialRow> = {},
): GatewayProviderApiKeyCredentialRow {
  const sealed = sealSecret(JSON.stringify(value));
  return {
    auth_method: "api_key",
    status: "connected",
    credential_ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    tag: sealed.tag,
    ...overrides,
  };
}

/** Fakes for the DB/env seams so precedence is tested without a database. */
function deps(overrides: ProviderCredentialResolvers = {}): ProviderCredentialResolvers {
  return {
    resolveUserConnection: async () => null,
    resolveOrgSecret: async () => null,
    env: {},
    devModeEnabled: () => false,
    ...overrides,
  };
}

describe("resolveProviderCredentialForRun precedence", () => {
  test("customer connection key wins over the org secret and the house env", async () => {
    const resolved = await resolveProviderCredentialForRun(
      { orgId: "org-a", userId: "user-a", provider: "anthropic" },
      deps({
        resolveUserConnection: async () => "sk-customer",
        resolveOrgSecret: async () => "sk-org",
        env: { ANTHROPIC_API_KEY: "sk-house" },
        devModeEnabled: () => true,
      }),
    );
    expect(resolved).toEqual({ value: "sk-customer", source: "user_connection" });
  });

  test("an absent/revoked customer connection falls back to the org secret", async () => {
    // The restricted view + opener already drop revoked rows, so the connection
    // resolver returns null; precedence then picks the org secret.
    const resolved = await resolveProviderCredentialForRun(
      { orgId: "org-a", userId: "user-a", provider: "openai" },
      deps({
        resolveUserConnection: async () => null,
        resolveOrgSecret: async () => "sk-org",
      }),
    );
    expect(resolved).toEqual({ value: "sk-org", source: "org_secret" });
  });

  test("with no customer or org key, dev mode falls back to the house env", async () => {
    const resolved = await resolveProviderCredentialForRun(
      { orgId: "org-a", userId: "user-a", provider: "openrouter" },
      deps({ env: { OPENROUTER_API_KEY: "sk-house" }, devModeEnabled: () => true }),
    );
    expect(resolved).toEqual({ value: "sk-house", source: "backend_env" });
  });

  test("production fails closed: no house-key spend without a customer or org key", async () => {
    const resolved = await resolveProviderCredentialForRun(
      { orgId: "org-a", userId: "user-a", provider: "openrouter" },
      deps({ env: { OPENROUTER_API_KEY: "sk-house" }, devModeEnabled: () => false }),
    );
    expect(resolved).toBeNull();
  });

  test("no userId skips the per-user connection lookup entirely", async () => {
    let connectionLookups = 0;
    const resolved = await resolveProviderCredentialForRun(
      { orgId: "org-a", userId: null, provider: "anthropic" },
      deps({
        resolveUserConnection: async () => {
          connectionLookups += 1;
          return "sk-customer";
        },
        resolveOrgSecret: async () => "sk-org",
      }),
    );
    expect(connectionLookups).toBe(0);
    expect(resolved).toEqual({ value: "sk-org", source: "org_secret" });
  });

  test("a sealed connected BYOK row opens and wins through the precedence", async () => {
    const apiKey = `sk-byok-${crypto.randomUUID()}`;
    const resolved = await resolveProviderCredentialForRun(
      { orgId: "org-a", userId: "user-a", provider: "anthropic" },
      deps({
        // Model the real path: the view row is opened by the shared opener.
        resolveUserConnection: async () =>
          openGatewayProviderApiKeyCredential(
            sealedRow({ authMethod: "api_key", value: apiKey }),
          ),
        resolveOrgSecret: async () => "sk-org",
      }),
    );
    expect(resolved).toEqual({ value: apiKey, source: "user_connection" });
  });

  test("a sealed REVOKED BYOK row is ignored and precedence falls back", async () => {
    const resolved = await resolveProviderCredentialForRun(
      { orgId: "org-a", userId: "user-a", provider: "anthropic" },
      deps({
        resolveUserConnection: async () =>
          openGatewayProviderApiKeyCredential(
            sealedRow({ authMethod: "api_key", value: "sk-revoked" }, { status: "revoked" }),
          ),
        resolveOrgSecret: async () => "sk-org",
      }),
    );
    expect(resolved).toEqual({ value: "sk-org", source: "org_secret" });
  });

  test("an OpenCode Zen free model runs on the house Zen account only, never a tenant's funded key", async () => {
    const funded = deps({
      resolveUserConnection: async () => "zen-user",
      resolveOrgSecret: async () => "zen-org",
      env: { OPENCODE_API_KEY: "zen-house", OPENROUTER_API_KEY: "sk-house" },
      devModeEnabled: () => false,
    });
    const free = { orgId: "org-a", userId: "user-a", provider: "opencode" as const, model: "opencode/big-pickle:free" };
    // Even with a user connection and an org secret present, the free model meets the house account.
    expect(await resolveProviderCredentialForRun(free, funded))
      .toEqual({ value: "zen-house", source: "backend_env" });
    // Zen's paid models keep the tenant precedence and never fall back to the house.
    expect(await resolveProviderCredentialForRun({ ...free, model: "opencode/claude-opus-5" }, funded))
      .toEqual({ value: "zen-user", source: "user_connection" });
    expect(await resolveProviderCredentialForRun(
      { ...free, model: "opencode/claude-opus-5" },
      deps({ resolveUserConnection: async () => null, resolveOrgSecret: async () => null, env: { OPENCODE_API_KEY: "zen-house" }, devModeEnabled: () => false }),
    )).toBeNull();
    // Without a house key a Zen free model has no credential at all.
    expect(await resolveProviderCredentialForRun(
      free,
      deps({ resolveUserConnection: async () => "zen-user", resolveOrgSecret: async () => "zen-org", env: {}, devModeEnabled: () => false }),
    )).toBeNull();
  });

  test("a free model runs on the member's key, then the organisation's, never the deployment's", async () => {
    const free = { orgId: "org-a", userId: "user-a", provider: "openrouter" as const, model: "vendor/model:free" };
    expect(await resolveProviderCredentialForRun(free, deps({
      resolveUserConnection: async () => "sk-member",
      resolveOrgSecret: async () => "sk-org",
      env: { OPENROUTER_API_KEY: "sk-house" },
      devModeEnabled: () => false,
    }))).toEqual({ value: "sk-member", source: "user_connection" });
    expect(await resolveProviderCredentialForRun(free, deps({
      resolveUserConnection: async () => null,
      resolveOrgSecret: async () => "sk-org",
      env: { OPENROUTER_API_KEY: "sk-house" },
      devModeEnabled: () => false,
    }))).toEqual({ value: "sk-org", source: "org_secret" });
    // No member or organisation key: production refuses rather than spend the deployment's key.
    expect(await resolveProviderCredentialForRun(free, deps({
      resolveUserConnection: async () => null,
      resolveOrgSecret: async () => null,
      env: { OPENROUTER_API_KEY: "sk-house" },
      devModeEnabled: () => false,
    }))).toBeNull();
  });

  test("org secret wins over the house env", async () => {
    const resolved = await resolveProviderCredential(
      "org-a",
      "openrouter",
      deps({
        resolveOrgSecret: async () => "sk-org",
        env: { OPENROUTER_API_KEY: "sk-house" },
        devModeEnabled: () => true,
      }),
    );
    expect(resolved).toEqual({ value: "sk-org", source: "org_secret" });
  });
});

describe("resolveChatProviderCredential", () => {
  test("the member's connection key wins over the org secret and the house env", async () => {
    const resolved = await resolveChatProviderCredential(
      { orgId: "org-a", userId: "user-a" },
      deps({
        resolveUserConnection: async () => "sk-customer",
        resolveOrgSecret: async () => "sk-org",
        env: { OPENROUTER_API_KEY: "sk-house" },
      }),
    );
    expect(resolved).toEqual({ value: "sk-customer", source: "user_connection" });
  });

  test("without a member key the organisation's secret serves", async () => {
    const resolved = await resolveChatProviderCredential(
      { orgId: "org-a", userId: "user-a" },
      deps({
        resolveUserConnection: async () => null,
        resolveOrgSecret: async (orgId, name) =>
          orgId === "org-a" && name === "OPENROUTER_API_KEY" ? "sk-org" : null,
        env: { OPENROUTER_API_KEY: "sk-house" },
        devModeEnabled: () => false,
      }),
    );
    expect(resolved).toEqual({ value: "sk-org", source: "org_secret" });
  });

  test("production fails closed: the house env never serves a member's chat turn", async () => {
    const resolved = await resolveChatProviderCredential(
      { orgId: "org-a", userId: "user-a" },
      deps({
        resolveUserConnection: async () => null,
        env: { OPENROUTER_API_KEY: "sk-house" },
        devModeEnabled: () => false,
      }),
    );
    expect(resolved).toBeNull();
  });

  test("development mode may still use the house env when nothing else is stored", async () => {
    const resolved = await resolveChatProviderCredential(
      { orgId: "org-a", userId: "user-a" },
      deps({
        resolveUserConnection: async () => null,
        env: { OPENROUTER_API_KEY: "sk-house" },
        devModeEnabled: () => true,
      }),
    );
    expect(resolved).toEqual({ value: "sk-house", source: "backend_env" });
  });
});
