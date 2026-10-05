import { describe, expect, test } from "bun:test";
import { providerDisplayName } from "./provider-display";

describe("providerDisplayName", () => {
  test("maps the gateway wire id to the product name", () => {
    expect(providerDisplayName("useagent")).toBe("UseAgent");
    expect(providerDisplayName("useagent-browser")).toBe("UseAgent Browser");
    expect(providerDisplayName("skynet-knowledge")).toBe("UseAgent");
    expect(providerDisplayName("skynet-browser")).toBe("UseAgent Browser");
  });

  test("passes genuine providers and other ids through unchanged", () => {
    for (const provider of [
      "opencode",
      "claude",
      "codex",
      "pi",
      "github",
      "skynet",
      "skynet-memory",
    ]) {
      expect(providerDisplayName(provider)).toBe(provider);
    }
  });

  test("passes a null provider through", () => {
    expect(providerDisplayName(null)).toBeNull();
  });
});
