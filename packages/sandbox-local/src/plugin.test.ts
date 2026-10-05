import { describe, expect, test } from "bun:test";
import { localImageFromEnv, localPlugin, localProviderConfig } from "./plugin";

describe("local plugin", () => {
  test("declares its identity and runtime layout", () => {
    expect(localPlugin.kind).toBe("local");
    expect(localPlugin.credentialRequired).toBe(false);
    expect(localPlugin.home).toBe("/home/user");
    expect(localPlugin.runsAsRoot).toBe(false);
    expect(localPlugin.runtime).toEqual({ home: "/home/user", workdir: "/home/user/work", bunExecutable: "/usr/local/bin/bun" });
    expect(localPlugin.template({})).toBe("");
    expect(localPlugin.previewAuthHeaders("anything")).toEqual({});
    expect(localPlugin.interactiveTerminalProblem?.()).toBeNull();
  });

  test("only the plane's loopback is a preview host", () => {
    expect(localPlugin.previewHostProblem(new URL("http://127.0.0.1:41234/"), {})).toBeNull();
    expect(localPlugin.previewHostProblem(new URL("http://localhost:41234/"), {})).toBeNull();
    expect(localPlugin.previewHostProblem(new URL("https://box.example.com/"), {})).toMatch(/loopback/);
  });

  test("reads the image, cpu and memory from the environment", () => {
    const digest = "sha256:" + "0".repeat(64);
    expect(localImageFromEnv({})).toBeNull();
    expect(localImageFromEnv({ SANDBOX_IMAGE_REF: "ghcr.io/x/y:1" })).toBeNull();
    expect(localImageFromEnv({ SANDBOX_IMAGE_REF: "ghcr.io/x/y:1", SANDBOX_IMAGE_DIGEST: digest })).toEqual({ ref: "ghcr.io/x/y:1", digest });
    expect(() => localImageFromEnv({ SANDBOX_IMAGE_REF: "r", SANDBOX_IMAGE_DIGEST: "sha256:short" })).toThrow(/sha256/);
    expect(localProviderConfig({})).toEqual({ image: null, runnerId: null, logins: [], cpu: 2, memoryGib: 8 });
    expect(localProviderConfig({ SANDBOX_CPU: "4", SANDBOX_MEMORY_GIB: "16" }, { runnerId: "rn1" })).toMatchObject({ cpu: 4, memoryGib: 16, runnerId: "rn1" });
    expect(() => localProviderConfig({ SANDBOX_CPU: "0" })).toThrow(/positive/);
    expect(localPlugin.configFromEnv("", {})).toEqual(localProviderConfig({}));
  });
});
