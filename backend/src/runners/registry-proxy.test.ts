import { expect, test } from "bun:test";
import { createRegistryProxyRoutes } from "./registry-proxy";
import type { PullCredentialSource } from "./registry-pull";
import type { RunnerRow } from "./store";

const IMAGE = { ref: "ghcr.io/useagenthq/sandbox:native-1", digest: "sha256:" + "0".repeat(64) };
const RUNNER = { id: "r1", status: "enrolled" } as unknown as RunnerRow;
const basic = (password: string) => `Basic ${btoa(`runner:${password}`)}`;

function harness(upstream: (url: string, init: RequestInit) => Response | Promise<Response>, options: { mint?: (string | null)[] } = {}) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const mints = options.mint ?? ["up-1"];
  let minted = 0;
  const forgotten: string[] = [];
  const credentials: PullCredentialSource = {
    async for() {
      const password = mints[Math.min(minted, mints.length - 1)];
      minted += 1;
      return password ? { registry: "ghcr.io", username: "x", password } : null;
    },
    forget(ref) { forgotten.push(ref); },
  };
  const app = createRegistryProxyRoutes({
    runnerForToken: async (token) => (token === "good-token" ? RUNNER : null),
    image: () => IMAGE,
    credentials,
    publicOrigin: () => "https://app.example",
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      calls.push({ url: String(input), method: init?.method ?? "GET", headers });
      return upstream(String(input), init ?? {});
    }) as unknown as typeof fetch,
    log: () => undefined,
  });
  const request = (path: string, init: RequestInit = {}) => app.request(`http://plane${path}`, init);
  return { request, calls, forgotten };
}

test("the version check challenges without a runner token and passes with one", async () => {
  const { request } = harness(() => new Response(null, { status: 500 }));
  const unauth = await request("/");
  expect(unauth.status).toBe(401);
  expect(unauth.headers.get("www-authenticate")).toBe('Bearer realm="https://app.example/v2/token",service="app.example"');
  expect(unauth.headers.get("docker-distribution-api-version")).toBe("registry/2.0");
  const bad = await request("/", { headers: { authorization: "Bearer wrong" } });
  expect(bad.status).toBe(401);
  const ok = await request("/", { headers: { authorization: "Bearer good-token" } });
  expect(ok.status).toBe(200);
});

test("the token endpoint hands a runner its own token back and refuses anything else", async () => {
  const { request } = harness(() => new Response(null, { status: 500 }));
  const ok = await request("/token?service=app.example&scope=repository:useagenthq/sandbox:pull", { headers: { authorization: basic("good-token") } });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ token: "good-token", access_token: "good-token", expires_in: 300 });
  expect((await request("/token", { headers: { authorization: basic("nope") } })).status).toBe(401);
  expect((await request("/token")).status).toBe(401);
});

test("a manifest is fetched upstream with the plane's credential and relayed with its digest", async () => {
  const { request, calls } = harness((url, init) => {
    expect(url).toBe("https://ghcr.io/v2/useagenthq/sandbox/manifests/native-1");
    return new Response('{"schemaVersion":2}', {
      status: 200,
      headers: { "content-type": "application/vnd.oci.image.index.v1+json", "docker-content-digest": IMAGE.digest, "set-cookie": "x=1" },
    });
  });
  const response = await request("/useagenthq/sandbox/manifests/native-1", {
    headers: { authorization: "Bearer good-token", accept: "application/vnd.oci.image.index.v1+json" },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("docker-content-digest")).toBe(IMAGE.digest);
  expect(response.headers.get("content-type")).toBe("application/vnd.oci.image.index.v1+json");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(await response.text()).toBe('{"schemaVersion":2}');
  expect(calls[0]?.headers.authorization).toBe("Bearer up-1");
  expect(calls[0]?.headers.accept).toBe("application/vnd.oci.image.index.v1+json");
  expect(calls[0]?.method).toBe("GET");
});

test("a blob request relays the upstream redirect so bytes never cross the plane", async () => {
  const { request } = harness(() => new Response(null, { status: 307, headers: { location: "https://cdn.example/blob?sig=1" } }));
  const response = await request(`/useagenthq/sandbox/blobs/${IMAGE.digest}`, { method: "HEAD", headers: { authorization: "Bearer good-token" } });
  expect(response.status).toBe(307);
  expect(response.headers.get("location")).toBe("https://cdn.example/blob?sig=1");
});

test("only the configured repository is served", async () => {
  const { request, calls } = harness(() => new Response(null, { status: 200 }));
  const response = await request("/useagenthq/backend/manifests/latest", { headers: { authorization: "Bearer good-token" } });
  expect(response.status).toBe(404);
  expect(calls).toEqual([]);
});

test("an upstream refusal mints once more, then reports the plane's credential as unusable", async () => {
  let attempts = 0;
  const { request, calls, forgotten } = harness(() => { attempts += 1; return new Response(null, { status: 401 }); }, { mint: ["up-1", "up-2"] });
  const response = await request("/useagenthq/sandbox/manifests/native-1", { headers: { authorization: "Bearer good-token" } });
  expect(response.status).toBe(502);
  expect(attempts).toBe(2);
  expect(calls.map((c) => c.headers.authorization)).toEqual(["Bearer up-1", "Bearer up-2"]);
  expect(forgotten).toEqual([IMAGE.ref]);
});

test("without a plane credential the proxy says so instead of pulling anonymously", async () => {
  const { request, calls } = harness(() => new Response(null, { status: 200 }), { mint: [null] });
  const response = await request("/useagenthq/sandbox/manifests/native-1", { headers: { authorization: "Bearer good-token" } });
  expect(response.status).toBe(502);
  expect(calls).toEqual([]);
});

test("the probe answers with and without its trailing slash", async () => {
  const { request } = harness(() => new Response(null, { status: 500 }));
  expect((await request("/", { headers: { authorization: "Bearer good-token" } })).status).toBe(200);
  expect((await request("", { headers: { authorization: "Bearer good-token" } })).status).toBe(200);
  expect((await request("/")).headers.get("www-authenticate")).toContain("Bearer realm=");
});

test("a reference that is not a tag or a digest never reaches the upstream", async () => {
  const { request, calls } = harness(() => new Response(null, { status: 200 }));
  for (const bad of ["..%2f..%2fbackend%2fmanifests%2flatest", "..", "a%2fb", "sha256:short"]) {
    const response = await request(`/useagenthq/sandbox/manifests/${bad}`, { headers: { authorization: "Bearer good-token" } });
    expect(response.status).toBe(404);
  }
  expect(calls).toEqual([]);
  const ok = await request(`/useagenthq/sandbox/manifests/sha256:${"a".repeat(64)}`, { headers: { authorization: "Bearer good-token" } });
  expect(ok.status).toBe(200);
});
