import { describe, expect, test } from "bun:test";
import {
  catalogAccount,
  modelOfferedTo,
  modelOfferedToUser,
  providerOfferedTo,
  providerOfferedToUser,
  providersOfferedTo,
  restrictedProviders,
} from "./provider-accounts";

const env = { PROVIDER_ACCOUNTS: " Cerebras : Owner@Example.com , second@example.com ; openai:third@example.com ;; anthropic: " };

describe("PROVIDER_ACCOUNTS", () => {
  test("parses providers, trims and lowercases accounts, and names a provider with no accounts", () => {
    const restricted = restrictedProviders(env);
    expect([...restricted.keys()].sort()).toEqual(["anthropic", "cerebras", "openai"]);
    expect([...restricted.get("cerebras")!].sort()).toEqual(["owner@example.com", "second@example.com"]);
    expect(restricted.get("anthropic")!.size).toBe(0);
    expect(restrictedProviders({}).size).toBe(0);
    expect(restrictedProviders({ PROVIDER_ACCOUNTS: "  " }).size).toBe(0);
  });

  test("offers a restricted provider only to its accounts, and an unrestricted one to everyone", () => {
    expect(providerOfferedTo("cerebras", "OWNER@example.com", env)).toBe(true);
    expect(providerOfferedTo("cerebras", "someone@example.com", env)).toBe(false);
    expect(providerOfferedTo("cerebras", null, env)).toBe(false);
    expect(providerOfferedTo("anthropic", "owner@example.com", env)).toBe(false);
    expect(providerOfferedTo("openrouter", null, env)).toBe(true);
    expect(providerOfferedTo("cerebras", "anyone@example.com", {})).toBe(true);
    expect(providersOfferedTo("owner@example.com", env)).not.toContain("openai");
    expect(providersOfferedTo("owner@example.com", env)).toContain("cerebras");
    expect(providersOfferedTo("nobody@example.com", env)).not.toContain("cerebras");
  });

  test("a model follows its provider", () => {
    expect(modelOfferedTo("opencode", "cerebras/qwen-3.8-27b", "owner@example.com", env)).toBe(true);
    expect(modelOfferedTo("opencode", "cerebras/qwen-3.8-27b", "someone@example.com", env)).toBe(false);
    expect(modelOfferedTo("opencode", "cerebras/qwen-3.8-27b", null, env)).toBe(false);
    expect(modelOfferedTo("opencode", "openrouter/google/gemini-3.7-flash", null, env)).toBe(true);
  });

  test("the user id path reads the account only when something is restricted", async () => {
    let reads = 0;
    const emailOf = async (id: string) => {
      reads++;
      return id === "u-owner" ? "owner@example.com" : "someone@example.com";
    };
    expect(await providerOfferedToUser("cerebras", "u-owner", env, emailOf)).toBe(true);
    expect(await providerOfferedToUser("cerebras", "u-other", env, emailOf)).toBe(false);
    expect(await providerOfferedToUser("cerebras", null, env, emailOf)).toBe(false);
    expect(await modelOfferedToUser("opencode", "cerebras/qwen-3.8-27b", "u-other", env, emailOf)).toBe(false);
    expect(reads).toBe(3);
    reads = 0;
    expect(await providerOfferedToUser("cerebras", "u-other", {}, emailOf)).toBe(true);
    expect(await catalogAccount("u-other", {}, emailOf)).toBeNull();
    expect(reads).toBe(0);
    expect(await catalogAccount("u-owner", env, emailOf)).toBe("owner@example.com");
  });
});
