import type { SandboxEnv, SandboxProviderPlugin, SandboxProviderPorts } from "@useagent/sandbox-contract";
import { LOCAL_HOME, LOCAL_WORKDIR, type LocalImage, LocalProvider, type LocalProviderConfig } from "./provider";

export const LOCAL_IMAGE_REF_ENV = "SANDBOX_IMAGE_REF";
export const LOCAL_IMAGE_DIGEST_ENV = "SANDBOX_IMAGE_DIGEST";

/** The native image the deployment names for local sandboxes, or null when it names none. */
export function localImageFromEnv(env: SandboxEnv): LocalImage | null {
  const ref = env[LOCAL_IMAGE_REF_ENV]?.trim() ?? "";
  const digest = env[LOCAL_IMAGE_DIGEST_ENV]?.trim() ?? "";
  if (!ref || !digest) return null;
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new Error(`${LOCAL_IMAGE_DIGEST_ENV} must be sha256:<64 hex>`);
  return { ref, digest };
}

function positiveInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function localProviderConfig(env: SandboxEnv, overrides: Partial<LocalProviderConfig> = {}): LocalProviderConfig {
  return {
    image: localImageFromEnv(env),
    runnerId: null,
    logins: [],
    cpu: positiveInteger("SANDBOX_CPU", env.SANDBOX_CPU, 2),
    memoryGib: positiveInteger("SANDBOX_MEMORY_GIB", env.SANDBOX_MEMORY_GIB, 8),
    ...overrides,
  };
}

/** A developer's machine, reached through its runner's link, as a sandbox provider. */
export const localPlugin: SandboxProviderPlugin<LocalProviderConfig> = {
  kind: "local",
  label: "This machine",
  // No vendor credential: a runner authenticates its own link with a token the plane issued.
  credentialEnv: "LOCAL_RUNNERS",
  credentialRequired: false,
  home: LOCAL_HOME,
  runsAsRoot: false,
  runtime: {
    home: LOCAL_HOME,
    workdir: LOCAL_WORKDIR,
    bunExecutable: "/usr/local/bin/bun",
  },
  previewAuthHeaders(): Record<string, string> {
    // Preview links are loopback addresses on the plane itself; nothing to authenticate upstream.
    return {};
  },
  configFromEnv(_apiKey, env) {
    return localProviderConfig(env);
  },
  template() {
    // The image is fixed by the deployment (ref and digest), never a per-lane snapshot.
    return "";
  },
  interactiveTerminalProblem() {
    return null;
  },
  createProvider(config, ports: SandboxProviderPorts = {}) {
    return new LocalProvider(config, ports);
  },
  previewHostProblem(url) {
    const host = url.hostname.toLowerCase();
    if (host === "127.0.0.1" || host === "localhost" || host === "[::1]") return null;
    return "preview host is not the control plane's loopback forwarder";
  },
};
