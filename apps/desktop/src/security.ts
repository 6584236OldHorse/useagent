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
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
}

type ResponseHeaders = Readonly<Record<string, readonly string[] | undefined>>;

function headerValues(headers: ResponseHeaders, name: string): readonly string[] {
  return Object.entries(headers).flatMap(([key, values]) => key.toLowerCase() === name ? values ?? [] : []);
}

function scriptNonce(headers: ResponseHeaders): string | undefined {
  const nonces = new Set<string>();
  for (const policy of headerValues(headers, "content-security-policy")) {
    for (const directive of policy.split(";")) {
      const [name, ...sources] = directive.trim().split(/\s+/);
      if (name?.toLowerCase() !== "script-src") continue;
      for (const source of sources) {
        if (!source.startsWith("'nonce-")) continue;
        const match = /^'nonce-([A-Za-z0-9+/_-]{16,256}={0,2})'$/.exec(source);
        if (!match) return undefined;
        nonces.add(match[1]!);
      }
    }
  }
  return nonces.size === 1 ? [...nonces][0] : undefined;
}

export function desktopContentPolicy(
  resourceType: string,
  statusCode: number,
  headers: ResponseHeaders,
  packaged: boolean,
): { policy: string; block: boolean } {
  const base = `object-src 'none'; base-uri 'self'`;
  if (resourceType !== "mainFrame") return { policy: base, block: false };
  const framed = `${base}; frame-ancestors 'none'`;
  if (statusCode >= 300 && statusCode < 400) return { policy: framed, block: false };
  const html = headerValues(headers, "content-type")
    .some(value => /^\s*(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(value));
  if (!html) return { policy: `${framed}; script-src 'none'`, block: false };
  const nonce = scriptNonce(headers);
  if (!nonce) return { policy: `${framed}; script-src 'none'`, block: true };
  const development = packaged ? "" : " 'unsafe-eval'";
  return {
    policy: `${framed}; script-src 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${development}`,
    block: false,
  };
}

export function desktopLoadErrorMessage(error: unknown): string {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : "The desktop could not start.";
  if (code === "ERR_BLOCKED_BY_CLIENT" || /^ERR_BLOCKED_BY_CLIENT(?:\s|\(|$)/.test(message)) {
    return "This server is missing the required script policy. Update the server and try again.";
  }
  return message;
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
