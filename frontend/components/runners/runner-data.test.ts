import { describe, expect, test } from "bun:test";
import {
  canRevokeRunner,
  localRunnerId,
  markRunnerRevoked,
  type Runner,
  PROVIDER_NAMES,
  runnerLocationLabel,
  runnerLoginAvailable,
  sandboxVendorLabel,
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
    expect(localRunnerId("local:rn_a:sha256:abc")).toBe("rn_a");
    expect(localRunnerId("local:rn_a")).toBeNull();
    expect(localRunnerId("cube:rn_a:container_1")).toBeNull();
  });

  test("names the machine for a local sandbox and says Cloud for any hosted one", () => {
    expect(runnerLocationLabel("local:rn_a:container_1", [runner])).toBe("Desk Mac");
    // Until the runner list names it, a local sandbox is the person's own machine.
    expect(runnerLocationLabel("local:rn_missing:container_1", [runner])).toBe("This Mac");
    // A hosted sandbox never names its vendor here, whatever the thread asked for.
    expect(runnerLocationLabel("sandbox_1", [runner])).toBe("Cloud");
    expect(runnerLocationLabel("sandbox_1", [runner], "local")).toBe("Cloud");
    // Before any sandbox exists the place the thread asked for names the run;
    // a thread that asked for nothing runs in the cloud.
    expect(runnerLocationLabel(null, [], "cloud")).toBe("Cloud");
    expect(runnerLocationLabel(null, [], "local")).toBe("This Mac");
    expect(runnerLocationLabel(null, [], null)).toBe("Cloud");
    expect(runnerLocationLabel("local:rn_a:container_1", [runner], "local")).toBe("Desk Mac");
  });

  test("keeps the vendor for a title: the deployment's own label, else the plugin's name", () => {
    expect(sandboxVendorLabel("daytona")).toBe("Daytona");
    expect(sandboxVendorLabel("cube")).toBe("Cube");
    // The E2B-protocol plugin keeps its id; the name follows what the deployment points at.
    expect(sandboxVendorLabel("cube", { ...PROVIDER_NAMES, cube: "E2B" })).toBe("E2B");
    expect(sandboxVendorLabel("daytona", { ...PROVIDER_NAMES, cube: "E2B" })).toBe("Daytona");
    expect(sandboxVendorLabel("acme")).toBe("acme");
    expect(sandboxVendorLabel(undefined)).toBeNull();
    expect(sandboxVendorLabel(" ")).toBeNull();
  });
});

describe("runner actions", () => {
  test("offers revoke only to the owner or an organization admin", () => {
    expect(canRevokeRunner(runner, "user_a", false)).toBe(true);
    expect(canRevokeRunner(runner, "user_b", true)).toBe(true);
    expect(canRevokeRunner(runner, "user_b", false)).toBe(false);
    expect(canRevokeRunner({ ...runner, status: "revoked" }, "user_a", true)).toBe(false);
    expect(markRunnerRevoked([runner], runner.id)).toEqual([{ ...runner, status: "revoked" }]);
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
