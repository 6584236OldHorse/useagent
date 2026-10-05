import { describe, expect, test } from "bun:test";
import { installRegistrySession, mintPullToken } from "./registry-session";
import type { RemoteHost } from "./remote-host";

describe("registry session", () => {
  test("mints a token scoped to the three release repositories only", async () => {
    let seen: URL | null = null;
    let auth = "";
    const stub = async (input: string | URL | Request, init?: RequestInit) => {
      seen = new URL(String(input));
      auth = String((init?.headers as Record<string, string>).authorization);
      return new Response(JSON.stringify({ token: "pull-token" }), { status: 200 });
    };
    const token = await mintPullToken("useagenthq", { user: "x", token: "gh-secret" }, stub as unknown as typeof fetch);
    expect(token).toBe("pull-token");
    expect(seen!.origin).toBe("https://ghcr.io");
    expect(seen!.searchParams.getAll("scope")).toEqual([
      "repository:useagenthq/backend:pull",
      "repository:useagenthq/gateway:pull",
      "repository:useagenthq/frontend:pull",
    ]);
    expect(auth).toBe(`Basic ${btoa("x:gh-secret")}`);
  });

  test("a refused exchange is an error, never an empty credential", async () => {
    await expect(
      mintPullToken("useagenthq", { user: "x", token: "bad" }, (async () => new Response("", { status: 401 })) as unknown as typeof fetch),
    ).rejects.toThrow("401");
  });

  test("installs the credential on the host for the run and removes it afterwards", async () => {
    const writes: Array<[string, string]> = [];
    const commands: string[] = [];
    const remote = {
      writeAtomic: async (path: string, body: string) => { writes.push([path, body]); },
      run: async (command: string) => { commands.push(command); return { code: 0, stdout: "", stderr: "" }; },
    } as unknown as RemoteHost;
    const cleanup = await installRegistrySession(remote, "/var/lib/useagent", "pull-token", () => "abc");
    expect(writes).toEqual([["/var/lib/useagent/registry-auth/abc/config.json", JSON.stringify({ auths: { "ghcr.io": { registrytoken: "pull-token" } } })]]);
    await remote.run("docker compose pull", {} as never);
    expect(commands.at(-1)).toBe("export DOCKER_CONFIG='/var/lib/useagent/registry-auth/abc'; docker compose pull");
    await cleanup();
    expect(commands.at(-1)).toBe("rm -f -- '/var/lib/useagent/registry-auth/abc/config.json'; rmdir -- '/var/lib/useagent/registry-auth/abc'");
    await remote.run("echo after", {} as never);
    expect(commands.at(-1)).toBe("echo after");
  });
});
