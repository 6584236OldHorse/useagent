import { describe, expect, test } from "bun:test";
import {
  deploymentProvidedProviders,
  openCodeZenModelId,
  providerCredentialName,
  providerForEngine,
} from "./provider";

describe("OpenCode Zen as a model provider", () => {
  test("an opencode/ id routes to the Zen provider on the sandbox engines only", () => {
    expect(providerForEngine("opencode", "opencode/big-pickle:free")).toBe("opencode");
    expect(providerForEngine("pi", "opencode/big-pickle:free")).toBe("opencode");
    expect(providerForEngine("opencode", "vendor/model:free")).toBe("openrouter");
    expect(providerForEngine("chat", "opencode/big-pickle:free")).toBe("openrouter");
    expect(providerCredentialName("opencode")).toBe("OPENCODE_API_KEY");
  });

  test("Zen's own id drops our prefix and the free marker", () => {
    expect(openCodeZenModelId("opencode/big-pickle:free")).toBe("big-pickle");
    expect(openCodeZenModelId("opencode/claude-opus-5")).toBe("claude-opus-5");
  });

  test("the deployment reports whether it holds a Zen key, never its value", () => {
    expect(deploymentProvidedProviders({ OPENCODE_API_KEY: "zen-house" }).opencode).toBe(true);
    expect(deploymentProvidedProviders({}).opencode).toBe(false);
  });

  test("in production a house key held for other work serves no member, the Zen lane key still does", () => {
    const keys = { OPENROUTER_API_KEY: "house", OPENAI_API_KEY: "house", OPENCODE_API_KEY: "zen-house" };
    expect(deploymentProvidedProviders({ ...keys, NODE_ENV: "production" })).toMatchObject({
      openrouter: false,
      openai: false,
      opencode: true,
    });
    expect(deploymentProvidedProviders({ ...keys, USEAGENT_DEV_MODE: "false" }).openrouter).toBe(false);
    expect(deploymentProvidedProviders({ ...keys, USEAGENT_DEV_MODE: "true", NODE_ENV: "production" }).openrouter).toBe(true);
  });
});
