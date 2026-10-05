// A pull-only registry credential for one promotion. The host keeps no
// standing login for the image registry: the controller mints a token scoped
// to the three release repositories, installs it as a temporary Docker config
// on the host for the duration of the run, and removes it afterwards.
import type { RemoteHost } from "./remote-host";

const REGISTRY = "ghcr.io";
const REPOSITORIES = ["backend", "gateway", "frontend"] as const;

export interface RegistryCredential {
  /** The account the token belongs to; the registry accepts any name with a GitHub token. */
  readonly user: string;
  readonly token: string;
}

/** Exchange a GitHub token for a registry token that can only pull the release images. */
export async function mintPullToken(
  organization: string,
  credential: RegistryCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const url = new URL(`https://${REGISTRY}/token`);
  url.searchParams.set("service", REGISTRY);
  for (const repository of REPOSITORIES) {
    url.searchParams.append("scope", `repository:${organization}/${repository}:pull`);
  }
  const response = await fetchImpl(url, {
    headers: { authorization: `Basic ${btoa(`${credential.user}:${credential.token}`)}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`registry token request returned ${response.status}`);
  const body = (await response.json()) as { token?: string };
  if (!body.token) throw new Error("registry token missing from the exchange response");
  return body.token;
}

/**
 * Install the pull token on the host and route every remote command through
 * it. Returns the cleanup that restores the remote and deletes the credential.
 */
export async function installRegistrySession(
  remote: RemoteHost,
  stateRoot: string,
  pullToken: string,
  randomId: () => string = () => crypto.randomUUID(),
): Promise<() => Promise<void>> {
  const directory = `${stateRoot}/registry-auth/${randomId()}`;
  await remote.writeAtomic(
    `${directory}/config.json`,
    JSON.stringify({ auths: { [REGISTRY]: { registrytoken: pullToken } } }),
  );
  const run = remote.run.bind(remote);
  remote.run = (command, options) => run(`export DOCKER_CONFIG='${directory}'; ${command}`, options);
  return async () => {
    remote.run = run;
    await run(`rm -f -- '${directory}/config.json'; rmdir -- '${directory}'`);
  };
}
