// The sandbox image is a private package, and a runner on someone's machine
// holds no registry credential: it holds a runner token. So the plane serves
// the image itself under /v2, the standard registry API. A runner logs in with
// its token (the engine exchanges it at /v2/token, the usual bearer dance),
// the plane forwards manifests to the upstream registry with its own pull-only
// credential, and blob downloads follow the upstream's redirect straight to
// its content host, so no image bytes cross the plane. Only the configured
// sandbox repository is served; nothing else is proxied.

import { Hono } from "hono";
import type { ImageRef } from "@useagent/runner-protocol";
import { bearerToken } from "./link";
import { imageRepository, type PullCredentialSource } from "./registry-pull";
import type { RunnerRow } from "./store";

export interface RegistryProxyDeps {
  readonly runnerForToken: (token: string) => Promise<RunnerRow | null>;
  /** The upstream image the plane serves; null when local runners have no image. */
  readonly image: () => ImageRef | null;
  readonly credentials: PullCredentialSource;
  /** Where runners reach this plane, for the token realm; e.g. https://app.useagent.org. */
  readonly publicOrigin: () => string;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (message: string) => void;
}

const API_VERSION: [string, string] = ["docker-distribution-api-version", "registry/2.0"];
const FORWARDED_REQUEST_HEADERS = ["accept", "range", "if-none-match"];
/** A tag, or a digest; nothing that could rewrite the upstream path. */
const REFERENCE = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|sha256:[0-9a-f]{64})$/;
const FORWARDED_RESPONSE_HEADERS = ["content-type", "content-length", "docker-content-digest", "etag", "location", "accept-ranges", "content-range", "last-modified"];
/** The token endpoint hands the runner token straight back; the engine caches it this long. */
const TOKEN_LIFETIME_SECONDS = 300;

function basicCredentials(header: string | undefined): { username: string; password: string } | null {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header ?? "");
  if (!match?.[1]) return null;
  let decoded: string;
  try {
    decoded = atob(match[1]);
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon < 0) return null;
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

function registryError(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ errors: [{ code, message }] }, { status, headers: { [API_VERSION[0]]: API_VERSION[1], ...headers } });
}

export function createRegistryProxyRoutes(deps: RegistryProxyDeps): Hono {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const log = deps.log ?? ((message: string) => console.warn(message));
  // Engines probe "/v2/" with the slash; Hono would otherwise route only "/v2".
  const app = new Hono({ strict: false });

  const challenge = () => {
    const origin = deps.publicOrigin().replace(/\/+$/, "");
    const host = new URL(origin).host;
    return registryError(401, "UNAUTHORIZED", "authentication required", {
      "www-authenticate": `Bearer realm="${origin}/v2/token",service="${host}"`,
    });
  };

  const runnerFromBearer = async (header: string | undefined): Promise<RunnerRow | null> => {
    const token = bearerToken(header);
    if (!token) return null;
    try {
      return await deps.runnerForToken(token);
    } catch (error) {
      log(`[registry] runner lookup failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  // The engine exchanges its login for a bearer token; the runner token is the login and the bearer.
  app.get("/token", async (c) => {
    const basic = basicCredentials(c.req.header("authorization"));
    const runner = basic ? await deps.runnerForToken(basic.password).catch(() => null) : null;
    if (!basic || !runner) return registryError(401, "UNAUTHORIZED", "a runner token is required");
    return Response.json(
      { token: basic.password, access_token: basic.password, expires_in: TOKEN_LIFETIME_SECONDS },
      { headers: { [API_VERSION[0]]: API_VERSION[1], "cache-control": "no-store" } },
    );
  });

  app.on(["GET", "HEAD"], "/", async (c) => {
    if (!(await runnerFromBearer(c.req.header("authorization")))) return challenge();
    return Response.json({}, { headers: { [API_VERSION[0]]: API_VERSION[1] } });
  });

  app.on(["GET", "HEAD"], "/:org/:repo/:kind{manifests|blobs}/:reference", async (c) => {
    if (!(await runnerFromBearer(c.req.header("authorization")))) return challenge();
    const image = deps.image();
    const upstream = image ? imageRepository(image.ref) : null;
    const name = `${c.req.param("org")}/${c.req.param("repo")}`;
    if (!image || !upstream || upstream.repository !== name) return registryError(404, "NAME_UNKNOWN", "repository name not known to registry");
    const kind = c.req.param("kind");
    const reference = c.req.param("reference");
    if (!REFERENCE.test(reference)) {
      return registryError(404, kind === "blobs" ? "BLOB_UNKNOWN" : "MANIFEST_UNKNOWN", `${kind === "blobs" ? "blob" : "manifest"} reference is not valid`);
    }
    const url = `https://${upstream.registry}/v2/${upstream.repository}/${kind}/${reference}`;
    const headers: Record<string, string> = {};
    for (const header of FORWARDED_REQUEST_HEADERS) {
      const value = c.req.header(header);
      if (value) headers[header] = value;
    }
    const request = async (): Promise<Response | null> => {
      const credential = await deps.credentials.for(image.ref);
      if (!credential?.password) return null;
      return fetchImpl(url, { method: c.req.method, headers: { ...headers, authorization: `Bearer ${credential.password}` }, redirect: "manual" });
    };
    let response = await request();
    if (response && (response.status === 401 || response.status === 403)) {
      // The upstream token ended early: mint once more before giving up.
      deps.credentials.forget(image.ref);
      response = await request();
    }
    if (!response) return registryError(502, "UNAVAILABLE", "the control plane has no registry credential");
    if (response.status === 401 || response.status === 403) {
      log(`[registry] upstream refused ${c.req.method} ${url}: ${response.status}`);
      return registryError(502, "UNAVAILABLE", "the upstream registry refused the control plane's credential");
    }
    const out = new Headers([API_VERSION]);
    for (const header of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(header);
      if (value) out.set(header, value);
    }
    return new Response(c.req.method === "HEAD" ? null : response.body, { status: response.status, headers: out });
  });

  return app;
}
