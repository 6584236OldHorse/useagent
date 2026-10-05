import { describe, expect, test } from "bun:test";
import type { SandboxProvider } from "@useagent/sandbox-contract";
import { runtimeRunSnapshot } from "./runtime-snapshot";
import { snapshotForBinding } from "./thread-sandbox";
import type { SandboxBinding } from "../sandboxes/binding";

const provider = { label: "fake" } as unknown as SandboxProvider;
const env = {
  SANDBOX_PROVIDER: "daytona",
  DAYTONA_SNAPSHOT: "daytona-snap",
  CUBE_TEMPLATE_ID: "cube-tpl",
  RUNTIME_BOX_SNAPSHOT: "box-runtime-snap",
  BOX_SNAPSHOT: "box-generic",
};

describe("runtime snapshot per provider", () => {
  test("names a provider other than the deployment default and gets that provider's template", () => {
    expect(runtimeRunSnapshot(env)).toBe("daytona-snap");
    expect(runtimeRunSnapshot(env, "daytona")).toBe("daytona-snap");
    expect(runtimeRunSnapshot(env, "cube")).toBe("cube-tpl");
    expect(runtimeRunSnapshot(env, "box")).toBe("box-runtime-snap");
    expect(() => runtimeRunSnapshot({ SANDBOX_PROVIDER: "daytona" }, "cube")).toThrow("RUNTIME_CUBE_TEMPLATE_ID");
  });

  test("a new sandbox on a member's preferred provider starts from that provider's template, not the default's", () => {
    const envBinding = (kind: SandboxBinding["kind"]): SandboxBinding =>
      ({ kind, provider, snapshot: null, credential: "env", userId: null, logins: [] });
    // The deployment default keeps the caller's snapshot.
    expect(snapshotForBinding(envBinding("daytona"), "daytona-snap", env)).toBe("daytona-snap");
    // A preferred Cube or Box gets its own template; the Daytona name is never handed to it.
    expect(snapshotForBinding(envBinding("cube"), "daytona-snap", env)).toBe("cube-tpl");
    expect(snapshotForBinding(envBinding("box"), "daytona-snap", env)).toBe("box-runtime-snap");
    // A personal computer keeps the snapshot its connection carries; a machine has none.
    expect(snapshotForBinding({ ...envBinding("box"), credential: "user", userId: "u1", snapshot: "mine" }, "daytona-snap", env)).toBe("mine");
    expect(snapshotForBinding({ ...envBinding("local"), credential: "user", userId: "u1" }, "daytona-snap", env)).toBe("");
  });
});
