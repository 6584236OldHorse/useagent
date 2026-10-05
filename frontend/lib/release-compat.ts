export const USEAGENT_API_COMPAT = "run-events-v1";

const CLIENT_COMMIT = process.env.NEXT_PUBLIC_USEAGENT_RELEASE_COMMIT?.trim().toLowerCase() || "dev";
export const CLIENT_RELEASE_FINGERPRINT = `${USEAGENT_API_COMPAT}:${CLIENT_COMMIT}`;

const RELOAD_MARKER = "skynet.release.reload";

export class FrontendReleaseMismatchError extends Error {
  constructor(
    readonly serverFingerprint: string,
    /** True when this tab already reloaded for this release and still differs:
     *  the page being served is older than the server, so another reload
     *  changes nothing until the deployment finishes. */
    readonly reloadedAlready = false,
  ) {
    super(
      reloadedAlready
        ? "This page is older than the server and a reload did not change that. The deployment is still finishing; try again in a minute."
        : "Frontend was updated. Reload before retrying this action.",
    );
    this.name = "FrontendReleaseMismatchError";
  }
}

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function isApiPath(path: string): boolean {
  return path.startsWith("/api/");
}

function isMutating(method: string | undefined): boolean {
  return !["GET", "HEAD"].includes((method ?? "GET").toUpperCase());
}

export function withClientReleaseHeader(path: string, init?: RequestInit): RequestInit | undefined {
  if (!isBrowser() || !isApiPath(path)) return init;
  const headers = new Headers(init?.headers);
  headers.set("x-useagent-client-release", CLIENT_RELEASE_FINGERPRINT);
  return { ...init, headers };
}

/** Schedule one reload per client release; returns false when this tab already
 *  reloaded for it, which means reloading again cannot change the bundle. */
export function scheduleReleaseReload(): boolean {
  if (!isBrowser()) return false;
  try {
    if (window.sessionStorage.getItem(RELOAD_MARKER) === CLIENT_RELEASE_FINGERPRINT) return false;
    window.sessionStorage.setItem(RELOAD_MARKER, CLIENT_RELEASE_FINGERPRINT);
  } catch {
    // Storage can be unavailable in hardened browsers; the reload is still safe.
  }
  window.setTimeout(() => window.location.reload(), 0);
  return true;
}

export function handleReleaseMismatch(response: Response, init?: RequestInit): void {
  const serverFingerprint =
    response.headers.get("x-useagent-release-fingerprint") ??
    response.headers.get("x-skynet-release-fingerprint");
  if (!serverFingerprint || serverFingerprint === CLIENT_RELEASE_FINGERPRINT) return;
  if (serverFingerprint.endsWith(":dev")) return;
  const reloading = scheduleReleaseReload();
  if (isMutating(init?.method)) throw new FrontendReleaseMismatchError(serverFingerprint, !reloading);
}
