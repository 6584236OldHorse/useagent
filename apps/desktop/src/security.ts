import { isIP } from "node:net";

export const REQUIRED_API_COMPAT = "run-events-v1";

function loopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return hostname === "localhost" || hostname.endsWith(".localhost") || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
}

export function planeUrl(value = "https://app.useagent.org"): URL {
  const url = new URL(value);
  const secure = url.protocol === "https:" || (url.protocol === "http:" && loopback(url.hostname));
  if (!secure || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The control plane URL must be an HTTPS origin or a local loopback HTTP origin.");
  }
  return url;
}

export function trustedIpcSender(frameUrl: string, mainFrame: boolean, origin: string): boolean {
  if (!mainFrame) return false;
  try {
    return new URL(frameUrl).origin === origin;
  } catch {
    return false;
  }
}

export function trustedNavigation(value: string, origin: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === origin ||
      (url.protocol === "https:" && url.hostname.endsWith(".clerk.accounts.dev") && url.pathname === "/v1/client/handshake")
    );
  } catch {
    return false;
  }
}

export function desktopContentPolicy(resourceType: string): string {
  return `object-src 'none'; base-uri 'self'${resourceType === "mainFrame" ? "; frame-ancestors 'none'" : ""}`;
}

export function externalUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) throw new Error("Invalid external URL.");
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw new Error("Invalid external URL.");
  return url.href;
}

export function runnerToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 8_192 ||
    value.trim() !== value ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error("Invalid runner token.");
  }
  return value;
}

export function planeManifest(value: unknown): { image: string } {
  if (!value || typeof value !== "object") throw new Error("The control plane returned an invalid configuration.");
  const config = value as {
    release?: { apiCompat?: unknown };
    runner?: { image?: { ref?: unknown; digest?: unknown } };
  };
  if (config.release?.apiCompat !== REQUIRED_API_COMPAT) {
    const actual = typeof config.release?.apiCompat === "string" ? config.release.apiCompat : "no API compatibility version";
    throw new Error(`This desktop requires ${REQUIRED_API_COMPAT}; the control plane reports ${actual}.`);
  }
  const ref = config.runner?.image?.ref;
  const digest = config.runner?.image?.digest;
  const image =
    typeof ref === "string" && ref.length <= 512 && typeof digest === "string" && /^sha256:[a-f0-9]{64}$/.test(digest)
      ? `${ref}@${digest}`
      : "Not advertised by control plane";
  return { image };
}
