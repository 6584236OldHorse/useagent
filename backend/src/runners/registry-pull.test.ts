import { expect, test } from "bun:test";
import { createPullCredentialSource, imageRepository, proxiedReference } from "./registry-pull";

const tokenResponse = (token: string, expiresIn?: number) =>
  Response.json(expiresIn === undefined ? { token } : { token, expires_in: expiresIn });

test("an image reference names its registry and repository", () => {
  expect(imageRepository("ghcr.io/useagenthq/sandbox:useagent-native-90dc3eb-f024f0258b")).toEqual({ registry: "ghcr.io", repository: "useagenthq/sandbox" });
  expect(imageRepository("ghcr.io/useagenthq/sandbox@sha256:" + "a".repeat(64))).toEqual({ registry: "ghcr.io", repository: "useagenthq/sandbox" });
  expect(imageRepository("127.0.0.1:5000/sandbox:dev")).toEqual({ registry: "127.0.0.1:5000", repository: "sandbox" });
  expect(imageRepository("useagent-runner-test:debian-1")).toBeNull();
});

test("without a registry token the welcome carries no login", async () => {
  const calls: string[] = [];
  const source = createPullCredentialSource({}, (async (input: string | URL) => { calls.push(String(input)); return tokenResponse("t"); }) as unknown as typeof fetch);
  expect(await source.for("ghcr.io/useagenthq/sandbox:x")).toBeNull();
  expect(calls).toEqual([]);
});

test("a pull-only token is minted per repository, cached until it nears expiry, and shared between concurrent welcomes", async () => {
  const calls: string[] = [];
  let clock = 1_000_000;
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    calls.push(`${String(input)} ${(init?.headers as Record<string, string>).authorization}`);
    return tokenResponse(`tok-${calls.length}`, 300);
  }) as unknown as typeof fetch;
  const source = createPullCredentialSource({ USEAGENT_REGISTRY_TOKEN: "ghp_secret", USEAGENT_REGISTRY_USER: "bot" }, fetchImpl, () => undefined, () => clock);
  const [a, b] = await Promise.all([source.for("ghcr.io/useagenthq/sandbox:one"), source.for("ghcr.io/useagenthq/sandbox:two")]);
  expect(a).toEqual({ registry: "ghcr.io", username: "bot", password: "tok-1" });
  expect(b).toBe(a);
  expect(calls).toEqual([`https://ghcr.io/token?service=ghcr.io&scope=repository%3Auseagenthq%2Fsandbox%3Apull Basic ${btoa("bot:ghp_secret")}`]);
  clock += 200_000;
  expect((await source.for("ghcr.io/useagenthq/sandbox:one"))?.password).toBe("tok-1");
  clock += 100_000;
  expect((await source.for("ghcr.io/useagenthq/sandbox:one"))?.password).toBe("tok-2");
  expect(await source.for("docker.io/library/debian:bookworm")).toBeNull();
  expect(calls).toHaveLength(2);
});

test("a refused mint is logged and leaves the welcome without a login", async () => {
  const logged: string[] = [];
  const source = createPullCredentialSource({ USEAGENT_REGISTRY_TOKEN: "bad" }, (async () => new Response("denied", { status: 403 })) as unknown as typeof fetch, (m) => logged.push(m));
  expect(await source.for("ghcr.io/useagenthq/sandbox:x")).toBeNull();
  expect(logged).toEqual(["[runners] no pull credential for ghcr.io/useagenthq/sandbox: registry token request returned 403"]);
});

test("the proxied reference keeps the repository and the tag or digest, under the plane's host", () => {
  expect(proxiedReference("ghcr.io/useagenthq/sandbox:native-1", "app.useagent.org")).toBe("app.useagent.org/useagenthq/sandbox:native-1");
  expect(proxiedReference("ghcr.io/useagenthq/sandbox@sha256:" + "a".repeat(64), "localhost:3201")).toBe("localhost:3201/useagenthq/sandbox@sha256:" + "a".repeat(64));
  expect(proxiedReference("useagent-runner-test:debian-1", "app.useagent.org")).toBeNull();
});

test("forgetting a repository makes the next request mint again", async () => {
  const calls: string[] = [];
  const source = createPullCredentialSource({ USEAGENT_REGISTRY_TOKEN: "t" }, (async (input: string | URL) => { calls.push(String(input)); return tokenResponse(`tok-${calls.length}`, 300); }) as unknown as typeof fetch, () => undefined);
  expect((await source.for("ghcr.io/useagenthq/sandbox:x"))?.password).toBe("tok-1");
  source.forget("ghcr.io/useagenthq/sandbox:y");
  expect((await source.for("ghcr.io/useagenthq/sandbox:x"))?.password).toBe("tok-2");
});
