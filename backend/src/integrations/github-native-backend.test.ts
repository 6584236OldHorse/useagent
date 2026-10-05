import { generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  GITHUB_NATIVE_RUNTIME_BINDING_ID,
  createGithubDelegatedConnectionBackend,
  createGithubNativeConnectionBackend,
} from "./github-native-backend";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_KEY = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

function response(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installation(overrides: Record<string, unknown> = {}) {
  return {
    id: 901,
    app_id: 4_689_651,
    app_slug: "useagent-cloud",
    repository_selection: "selected",
    suspended_at: null,
    account: {
      id: 77,
      login: "acme-inc",
      avatar_url: "https://avatars.example/acme.png",
      type: "Organization",
    },
    permissions: {
      metadata: "read",
      contents: "read",
      issues: "read",
      pull_requests: "read",
      administration: "none",
    },
    ...overrides,
  };
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const CONFIG = {
  appId: "4689651",
  appSlug: "useagent-cloud",
  privateKey: PRIVATE_KEY,
  clientId: "Iv1.client",
  clientSecret: "client-secret",
};

/** GitHub as the installer sees it: the callback code becomes a user token,
 *  which lists `reachable` installations a page at a time. Anything else is
 *  an App call and goes to `appFetch`. */
function installer(appFetch: Fetch, reachable: readonly number[] = [901]): Fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/login/oauth/access_token") {
      expect(JSON.parse(String(init?.body))).toEqual({
        client_id: "Iv1.client",
        client_secret: "client-secret",
        code: "installer-code",
      });
      return response(200, { access_token: "ghu_installer", token_type: "bearer" });
    }
    if (url.pathname === "/user/installations") {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer ghu_installer");
      const page = Number(url.searchParams.get("page"));
      const ids = reachable.slice((page - 1) * 100, page * 100);
      return response(200, { total_count: reachable.length, installations: ids.map((id) => ({ id })) });
    }
    return appFetch(input, init);
  };
}

function backend(fetchImpl: Fetch, reachable?: readonly number[]) {
  return createGithubNativeConnectionBackend(
    CONFIG,
    { fetch: installer(fetchImpl, reachable), now: () => 1_787_480_000_000 },
  );
}

describe("GitHub native connection backend", () => {
  test("builds the public installation URL with opaque state", () => {
    const instance = backend(async () => response(500));
    expect(instance.buildInstallUrl({ state: "state/a+b" })).toBe(
      "https://github.com/apps/useagent-cloud/installations/new?state=state%2Fa%2Bb",
    );
  });

  test("validates the configured App identity with an App JWT", async () => {
    let authorization = "";
    const instance = backend(async (input, init) => {
      expect(String(input)).toBe("https://api.github.com/app");
      authorization = new Headers(init?.headers).get("Authorization") ?? "";
      return response(200, { id: 4_689_651, slug: "useagent-cloud" });
    });

    await expect(instance.validateApp()).resolves.toEqual({
      appId: "4689651",
      appSlug: "useagent-cloud",
    });
    const [, encodedPayload] = authorization.replace(/^Bearer /u, "").split(".");
    const payload = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8")) as {
      iss: string;
      exp: number;
      iat: number;
    };
    expect(payload.iss).toBe("4689651");
    expect(payload.exp - payload.iat).toBe(600);
  });

  test("projects a validated installation without credential material", async () => {
    const instance = backend(async (input) => {
      expect(String(input)).toBe("https://api.github.com/app/installations/901");
      return response(200, installation());
    });

    await expect(instance.completeInstall(901, "installer-code")).resolves.toEqual({
      runtimeBindingId: GITHUB_NATIVE_RUNTIME_BINDING_ID,
      externalConnectionId: "901",
      externalConnectionName: "acme-inc",
      authMethod: "custom_credential",
      account: {
        externalAccountId: "77",
        displayName: "acme-inc",
        avatarUrl: "https://avatars.example/acme.png",
      },
      scopes: ["contents:read", "issues:read", "metadata:read", "pull_requests:read"],
    });
  });

  test("refuses an installation id the installer cannot reach, before reading it", async () => {
    const appCalls: string[] = [];
    const forged = backend(async (input) => {
      appCalls.push(String(input));
      return response(200, installation());
    }, [555, 556]);
    await expect(forged.completeInstall(901, "installer-code")).rejects.toThrow(
      "not accessible to the signed-in GitHub user",
    );
    expect(appCalls).toEqual([]);
  });

  test("finds the installation on a later page of the installer's list", async () => {
    const reachable = [...Array.from({ length: 150 }, (_, index) => index + 1), 901];
    const instance = backend(async () => response(200, installation()), reachable);
    await expect(instance.completeInstall(901, "installer-code")).resolves.toMatchObject({
      externalConnectionId: "901",
    });
  });

  test("refuses when GitHub turns the code down", async () => {
    const instance = createGithubNativeConnectionBackend(CONFIG, {
      fetch: async () => response(200, { error: "bad_verification_code" }),
      now: () => 1_787_480_000_000,
    });
    await expect(instance.completeInstall(901, "stale-code")).rejects.toThrow(
      "GitHub user authorization was refused",
    );
  });

  test("rejects an installation owned by another GitHub App", async () => {
    const instance = backend(async () => response(200, installation({ app_id: 123 })));
    await expect(instance.completeInstall(901, "installer-code")).rejects.toThrow(
      "does not belong to the configured App",
    );
  });

  test("rejects suspended installations", async () => {
    const instance = backend(async () =>
      response(200, installation({ suspended_at: "2026-08-23T00:00:00Z" })),
    );
    await expect(instance.completeInstall(901, "installer-code")).rejects.toThrow("installation is suspended");
  });

  test("accepts only publication write permissions and preserves their actual scope", async () => {
    const instance = backend(async () =>
      response(200, installation({ permissions: {
        contents: "write", pull_requests: "write", issues: "read", metadata: "read",
      } })),
    );
    await expect(instance.completeInstall(901, "installer-code")).resolves.toMatchObject({
      scopes: ["contents:write", "issues:read", "metadata:read", "pull_requests:write"],
    });
    for (const permission of ["administration", "issues", "workflows"]) {
      const excessive = backend(async () => response(200, installation({
        permissions: { contents: "write", pull_requests: "write", [permission]: "write" },
      })));
      await expect(excessive.completeInstall(901, "installer-code")).rejects.toThrow(
        `unsupported permissions: ${permission}:write`,
      );
    }
  });

  test("disconnect is idempotent when GitHub already removed the installation", async () => {
    const methods: string[] = [];
    const instance = backend(async (_input, init) => {
      methods.push(init?.method ?? "GET");
      return response(404);
    });
    await expect(instance.disconnectInstallation(901)).resolves.toBeUndefined();
    expect(methods).toEqual(["DELETE"]);
  });

  test("disconnect requires GitHub to confirm deletion", async () => {
    const instance = backend(async () => response(403));
    await expect(instance.disconnectInstallation(901)).rejects.toThrow(
      "disconnect failed: HTTP 403",
    );
  });

  test("adapts installation callbacks to the shared delegated lifecycle", async () => {
    const delegated = createGithubDelegatedConnectionBackend(
      CONFIG,
      { fetch: installer(async () => response(200, installation())), now: () => 1_787_480_000_000 },
    );
    await expect(delegated.listConnectableProviders()).resolves.toEqual(["github"]);
    const started = await delegated.startConnect({
      orgId: "org-1",
      userId: "user-1",
      provider: "github",
      state: "opaque-state",
    });
    expect(started.redirectUrl).toBe(
      "https://github.com/apps/useagent-cloud/installations/new?state=opaque-state",
    );
    await expect(
      delegated.completeConnect({
        orgId: "org-1",
        userId: "user-1",
        provider: "github",
        backendSessionRef: started.backendSessionRef,
        callback: { installation_id: "901", setup_action: "install", code: "installer-code" },
      }),
    ).resolves.toMatchObject({
      runtimeBindingId: GITHUB_NATIVE_RUNTIME_BINDING_ID,
      externalConnectionId: "901",
    });
    // A setup-URL callback carries no user code: the id alone binds nothing.
    await expect(
      delegated.completeConnect({
        orgId: "org-1",
        userId: "user-1",
        provider: "github",
        backendSessionRef: started.backendSessionRef,
        callback: { installation_id: "901", setup_action: "install" },
      }),
    ).rejects.toThrow("missing the user authorization code");
  });

  test("offers no new connect without the App's OAuth client", async () => {
    const { clientId: _clientId, clientSecret: _clientSecret, ...appOnly } = CONFIG;
    const delegated = createGithubDelegatedConnectionBackend(appOnly, {
      fetch: async () => response(200, installation()),
      now: () => 1_787_480_000_000,
    });
    await expect(delegated.listConnectableProviders()).resolves.toEqual([]);
    await expect(
      createGithubNativeConnectionBackend(appOnly, {
        fetch: async () => response(200, installation()),
      }).completeInstall(901, "installer-code"),
    ).rejects.toThrow("GitHub user authorization is not configured");
  });
});
