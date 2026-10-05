// The sandbox image lives in a private registry. A runner cannot pull it
// anonymously, so the plane exchanges its own registry credential for a
// short-lived token that can only pull that one repository, and hands the
// token to the runner in its welcome. GHCR's token endpoint is the only one
// spoken here; without a credential the welcome carries no login.

import type { ImagePullCredential } from "@useagent/runner-protocol";

const GHCR = "ghcr.io";
/** GHCR does not report a lifetime for these tokens; they last well past this. */
const DEFAULT_LIFETIME_SECONDS = 300;
const RENEW_MARGIN_SECONDS = 30;

export interface RegistryPullEnv {
  readonly USEAGENT_REGISTRY_TOKEN?: string;
  readonly USEAGENT_REGISTRY_USER?: string;
}

/** Registry host and repository path of an OCI reference, or null when it is not one we can log into. */
export function imageRepository(ref: string): { registry: string; repository: string } | null {
  const match = /^([a-z0-9.-]+\.[a-z0-9]+(?::\d+)?)\/([a-z0-9._\/-]+?)(?:[:@].*)?$/i.exec(ref.trim());
  if (!match) return null;
  return { registry: match[1].toLowerCase(), repository: match[2] };
}

export interface PullCredentialSource {
  /** The login a runner needs to pull `ref`, or null when none is configured or the mint failed. */
  for(ref: string): Promise<ImagePullCredential | null>;
}

export function createPullCredentialSource(
  env: RegistryPullEnv,
  fetchImpl: typeof fetch = fetch,
  log: (message: string) => void = (message) => console.warn(message),
  now: () => number = Date.now,
): PullCredentialSource {
  const token = env.USEAGENT_REGISTRY_TOKEN?.trim();
  const user = env.USEAGENT_REGISTRY_USER?.trim() || "x";
  const cache = new Map<string, { credential: ImagePullCredential; expiresAt: number }>();
  const inflight = new Map<string, Promise<ImagePullCredential | null>>();
  return {
    async for(ref) {
      if (!token) return null;
      const target = imageRepository(ref);
      if (!target || target.registry !== GHCR) return null;
      const cached = cache.get(target.repository);
      if (cached && cached.expiresAt > now()) return cached.credential;
      let pending = inflight.get(target.repository);
      if (!pending) {
        pending = mint(target.registry, target.repository).finally(() => inflight.delete(target.repository));
        inflight.set(target.repository, pending);
      }
      return pending;
    },
  };

  async function mint(registry: string, repository: string): Promise<ImagePullCredential | null> {
    const url = new URL(`https://${registry}/token`);
    url.searchParams.set("service", registry);
    url.searchParams.set("scope", `repository:${repository}:pull`);
    try {
      const response = await fetchImpl(url, { headers: { authorization: `Basic ${btoa(`${user}:${token}`)}` } });
      if (!response.ok) throw new Error(`registry token request returned ${response.status}`);
      const body = (await response.json()) as { token?: string; expires_in?: number };
      if (!body.token) throw new Error("registry token response carried no token");
      const lifetime = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : DEFAULT_LIFETIME_SECONDS;
      const credential: ImagePullCredential = { registry, username: user, password: body.token };
      cache.set(repository, { credential, expiresAt: now() + Math.max(1, lifetime - RENEW_MARGIN_SECONDS) * 1000 });
      return credential;
    } catch (error) {
      log(`[runners] no pull credential for ${registry}/${repository}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}
