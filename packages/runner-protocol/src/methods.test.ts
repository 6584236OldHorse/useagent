import { describe, expect, test } from "bun:test";
import { composeLocalSandboxId, parseLocalSandboxId } from "./methods";

describe("local sandbox ids", () => {
  test("compose and parse", () => {
    const id = composeLocalSandboxId("rn_01", "5f3a9c");
    expect(id).toBe("local:rn_01:5f3a9c");
    expect(parseLocalSandboxId(id)).toEqual({ runnerId: "rn_01", containerId: "5f3a9c" });
  });

  test("container ids may contain colons, runner ids may not", () => {
    expect(parseLocalSandboxId("local:rn:sha256:abc")).toEqual({ runnerId: "rn", containerId: "sha256:abc" });
    expect(() => composeLocalSandboxId("a:b", "c")).toThrow();
    expect(() => composeLocalSandboxId("", "c")).toThrow();
    expect(() => composeLocalSandboxId("a", "")).toThrow();
  });

  test("other providers' ids are not local", () => {
    expect(parseLocalSandboxId("sb-123")).toBeNull();
    expect(parseLocalSandboxId("local:")).toBeNull();
    expect(parseLocalSandboxId("local:rn")).toBeNull();
    expect(parseLocalSandboxId("local:rn:")).toBeNull();
    expect(parseLocalSandboxId("local::c")).toBeNull();
  });
});
