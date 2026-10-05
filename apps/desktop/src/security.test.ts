import { describe, expect, test } from "bun:test";
import { desktopContentPolicy, desktopLoadErrorMessage, externalUrl, planeManifest, planeUrl, runnerToken, trustedIpcSender, trustedNavigation } from "./security";

describe("desktop security boundaries", () => {
  test("accepts secure planes and loopback development only", () => {
    expect(planeUrl().origin).toBe("https://app.useagent.org");
    expect(planeUrl("http://127.0.0.1:3401").origin).toBe("http://127.0.0.1:3401");
    expect(() => planeUrl("http://example.com")).toThrow();
    expect(() => planeUrl("https://example.com/path")).toThrow();
  });

  test("requires the top frame and exact plane origin for IPC", () => {
    expect(trustedIpcSender("https://plane.example/settings", true, "https://plane.example")).toBe(true);
    expect(trustedIpcSender("https://plane.example/settings", false, "https://plane.example")).toBe(false);
    expect(trustedIpcSender("https://plane.example.attacker.test", true, "https://plane.example")).toBe(false);
  });

  test("limits navigation to the plane", () => {
    expect(trustedNavigation("https://plane.example/login", "https://plane.example")).toBe(true);
    expect(trustedNavigation("https://identity.example/handshake", "https://plane.example")).toBe(false);
    expect(trustedNavigation("https://attacker.example", "https://plane.example")).toBe(false);
  });

  test("enforces the server script nonce only on HTML app frames", () => {
    const nonce = "aBcDeFgHiJkLmNoPqRsTuVwX";
    const headers = {
      "Content-Type": ["text/html; charset=utf-8"],
      "Content-Security-Policy": [`default-src 'self'; script-src 'nonce-${nonce}' 'strict-dynamic'`],
    };
    const production = desktopContentPolicy("mainFrame", 200, headers, true);
    expect(production).toEqual({
      policy: `object-src 'none'; base-uri 'self'; frame-ancestors 'none'; script-src 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`,
      block: false,
    });
    expect(production.policy.split(/\s+|;/)).not.toContain("'unsafe-eval'");
    expect(desktopContentPolicy("mainFrame", 200, {
      "content-type": ["text/html"],
      "content-security-policy": ["style-src 'nonce-not-a-script-nonce'"],
    }, true).block).toBe(true);
    expect(desktopContentPolicy("mainFrame", 200, {
      "content-type": ["text/html"],
      "content-security-policy": ["script-src 'nonce-short'"],
    }, true).block).toBe(true);
    expect(desktopContentPolicy("mainFrame", 200, {
      "content-type": ["application/xhtml+xml"],
    }, true).block).toBe(true);
    expect(desktopContentPolicy("mainFrame", 200, {
      "content-type": ["image/svg+xml"],
    }, true).policy).toContain("script-src 'none'");
    expect(desktopContentPolicy("script", 200, {}, true)).toEqual({
      policy: "object-src 'none'; base-uri 'self'",
      block: false,
    });
    expect(desktopContentPolicy("mainFrame", 302, {}, true).block).toBe(false);
    expect(desktopContentPolicy("mainFrame", 200, headers, false).policy).toContain(" 'unsafe-eval'");
  });

  test("every subframe but a PDF runs in an opaque origin, away from the preload bridge", () => {
    const sandboxed = "object-src 'none'; base-uri 'self'; sandbox allow-scripts allow-forms allow-popups allow-downloads";
    expect(desktopContentPolicy("subFrame", 200, { "content-type": ["text/html"] }, true)).toEqual({ policy: sandboxed, block: false });
    expect(desktopContentPolicy("subFrame", 200, {}, true).policy).toBe(sandboxed);
    expect(sandboxed).not.toContain("allow-same-origin");
    expect(desktopContentPolicy("subFrame", 200, { "Content-Type": ["application/pdf"] }, true).policy).toBe("object-src 'none'; base-uri 'self'");
    expect(desktopContentPolicy("subFrame", 200, { "content-type": ["application/pdfx"] }, true).policy).toBe(sandboxed);
  });

  test("turns only the canceled security load into an actionable startup error", () => {
    expect(desktopLoadErrorMessage(new Error("ERR_BLOCKED_BY_CLIENT (-20) loading https://plane.example")))
      .toBe("This server is missing the required script policy. Update the server and try again.");
    expect(desktopLoadErrorMessage(Object.assign(new Error("request blocked"), { code: "ERR_BLOCKED_BY_CLIENT" })))
      .toBe("This server is missing the required script policy. Update the server and try again.");
    expect(desktopLoadErrorMessage(new Error("ERR_CONNECTION_REFUSED"))).toBe("ERR_CONNECTION_REFUSED");
  });

  test("validates runner tokens and external URLs", () => {
    expect(runnerToken("runner-token")).toBe("runner-token");
    expect(() => runnerToken(" runner-token")).toThrow();
    expect(() => runnerToken("runner-token\nsecond-line")).toThrow();
    expect(externalUrl("https://docs.example/path")).toBe("https://docs.example/path");
    expect(() => externalUrl("file:///tmp/payload")).toThrow();
    expect(() => externalUrl("https://user:secret@example.com")).toThrow();
  });

  test("gates the explicit API contract without comparing commit hashes", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    expect(
      planeManifest({
        release: { apiCompat: "run-events-v1", commit: "dev", fingerprint: "run-events-v1:dev" },
        runner: { image: { ref: "registry.example/sandbox:latest", digest } },
      }),
    ).toEqual({ image: `registry.example/sandbox:latest@${digest}` });
    expect(() => planeManifest({ release: { apiCompat: "older-api" } })).toThrow(
      "This desktop requires run-events-v1; the control plane reports older-api.",
    );
  });
});
