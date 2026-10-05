import { describe, expect, test } from "bun:test";
import {
  localRunnerId,
  type Runner,
  runnerLocationLabel,
  runnerLoginAvailable,
} from "./runner-data";

const runner = {
  id: "rn_a",
  name: "Desk Mac",
  platform: "darwin-arm64",
  backend: "apple",
  version: "0.0.5",
  status: "online",
  lastSeenAt: null,
  logins: ["codex"],
  imageDigest: "sha256:abc",
  ownerUserId: "user_a",
} satisfies Runner;

describe("runner location", () => {
  test("resolves only the frozen local sandbox id shape", () => {
    expect(localRunnerId("local:rn_a:container_1")).toBe("rn_a");
    expect(localRunnerId("local:rn_a")).toBeNull();
    expect(localRunnerId("cube:rn_a:container_1")).toBeNull();
  });

  test("uses the machine list for local and the recorded binding for cloud", () => {
    expect(runnerLocationLabel("local:rn_a:container_1", undefined, [runner])).toBe("Desk Mac");
    expect(runnerLocationLabel("local:rn_missing:container_1", undefined, [runner])).toBe(
      "Unknown machine",
    );
    expect(runnerLocationLabel("sandbox_1", "cube", [runner])).toBe("cube");
    expect(runnerLocationLabel("sandbox_1", undefined, [runner])).toBe("Unknown runtime");
  });
});

describe("runner login availability", () => {
  test("requires both an online report and the organization policy", () => {
    const allowed = { allowLocalExecution: true, allowLocalLogins: true };
    expect(runnerLoginAvailable("codex", allowed, [runner], "user_a", true)).toBe(true);
    expect(runnerLoginAvailable("claude", allowed, [runner], "user_a", true)).toBe(false);
    expect(
      runnerLoginAvailable(
        "codex",
        { ...allowed, allowLocalLogins: false },
        [runner],
        "user_a",
        true,
      ),
    ).toBe(false);
    expect(
      runnerLoginAvailable(
        "codex",
        { ...allowed, allowLocalExecution: false },
        [runner],
        "user_a",
        true,
      ),
    ).toBe(false);
    expect(
      runnerLoginAvailable(
        "codex",
        allowed,
        [{ ...runner, status: "offline" }],
        "user_a",
        true,
      ),
    ).toBe(false);
    expect(runnerLoginAvailable("codex", allowed, [runner], "user_b", true)).toBe(false);
    expect(runnerLoginAvailable("codex", allowed, [runner], "user_a", false)).toBe(false);
  });
});
