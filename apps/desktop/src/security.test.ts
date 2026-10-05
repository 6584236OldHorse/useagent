import { describe, expect, test } from "bun:test";
import { desktopContentPolicy, externalUrl, planeManifest, planeUrl, runnerToken, trustedIpcSender, trustedNavigation } from "./security";

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

  test("limits navigation to the plane and the development identity handshake", () => {
    expect(trustedNavigation("https://plane.example/login", "https://plane.example")).toBe(true);
    expect(
      trustedNavigation(
        "https://instance.clerk.accounts.dev/v1/client/handshake?redirect_url=https%3A%2F%2Fplane.example",
        "https://plane.example",
      ),
    ).toBe(true);
    expect(trustedNavigation("https://instance.clerk.accounts.dev/other", "https://plane.example")).toBe(false);
    expect(trustedNavigation("https://attacker.example", "https://plane.example")).toBe(false);
  });

  test("keeps framing protection on the app while preserving backend iframe policy", () => {
    expect(desktopContentPolicy("mainFrame")).toContain("frame-ancestors 'none'");
    expect(desktopContentPolicy("subFrame")).toBe("object-src 'none'; base-uri 'self'");
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
