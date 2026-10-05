import { COMPUTER_PROVIDER_KINDS } from "./binding";
import { SANDBOX_PROVIDER_KINDS, sandboxPlugin } from "./plugins";
import { afterEach, describe, expect, test } from "bun:test";
import { DaytonaProvider } from "@useagent/sandbox-daytona";
import {
  boxApiConfig,
  sandboxPreviewHeaders,
  sandboxProvider,
  sandboxProviderApiKey,
  sandboxProviderKind,
  sandboxProviderLabel,
  sandboxRuntimeLayout,
  sandboxTemplate,
} from "./provider";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("sandbox provider selection", () => {
  test("keeps Daytona as the default", () => {
    expect(sandboxProviderKind({})).toBe("daytona");
  });

  test("a developer's machine is never the deployment's default provider", () => {
    expect(() => sandboxProviderKind({ SANDBOX_PROVIDER: "local" })).toThrow(/must be daytona, cube, box/);
    expect(sandboxRuntimeLayout("local")).toEqual({
      home: "/home/user",
      workdir: "/home/user/work",
      bunExecutable: "/usr/local/bin/bun",
      runsAsRoot: false,
    });
  });

  test("derives root and non-root runtime layouts from provider plugins", () => {
    expect(sandboxRuntimeLayout("daytona")).toEqual({
      home: "/root",
      workdir: "/root/work",
      bunExecutable: "/usr/local/bin/bun",
      runsAsRoot: true,
    });
    expect(sandboxRuntimeLayout("cube")).toEqual({
      home: "/root",
      workdir: "/root/work",
      bunExecutable: "/usr/local/bin/bun",
      runsAsRoot: true,
    });
    expect(sandboxRuntimeLayout("box")).toEqual({
      home: "/home/user",
      workdir: "/home/user/work",
      runsAsRoot: false,
      bunExecutable: "/usr/local/bin/bun",
    });
  });

  test("constructs the explicit Daytona adapter", () => {
    delete process.env.SANDBOX_PROVIDER;
    expect(sandboxProvider("daytona-key")).toBeInstanceOf(DaytonaProvider);
  });

  test("selects Cube explicitly", () => {
    expect(sandboxProviderKind({ SANDBOX_PROVIDER: "cube" })).toBe("cube");
  });

  test("rejects unknown providers instead of silently falling back", () => {
    expect(() => sandboxProviderKind({ SANDBOX_PROVIDER: "other" })).toThrow(
      "SANDBOX_PROVIDER must be daytona, cube, box",
    );
  });

  test("resolves the selected provider credential", () => {
    expect(sandboxProviderApiKey({ DAYTONA_API_KEY: "daytona-key" })).toBe("daytona-key");
    expect(
      sandboxProviderApiKey({
        SANDBOX_PROVIDER: "cube",
        CUBE_API_KEY: "cube-key",
        DAYTONA_API_KEY: "daytona-key",
      }),
    ).toBe("cube-key");
  });

  test("allows a loopback Cube deployment without API auth", () => {
    expect(
      sandboxProviderApiKey({
        SANDBOX_PROVIDER: "cube",
        CUBE_API_URL: "http://127.0.0.1:3000",
      }),
    ).toBe("");
  });

  test("uses the Cube template instead of a Daytona snapshot", () => {
    expect(
      sandboxTemplate("DAYTONA_SNAPSHOT", {
        SANDBOX_PROVIDER: "cube",
        CUBE_TEMPLATE_ID: "cube-template",
        DAYTONA_SNAPSHOT: "daytona-template",
      }),
    ).toBe("cube-template");
    expect(
      sandboxTemplate("DAYTONA_SNAPSHOT", {
        DAYTONA_SNAPSHOT: "daytona-template",
      }),
    ).toBe("daytona-template");
  });
});

describe("Box provider selection", () => {
  test("selects Box explicitly and reads its own key, snapshot, and machine type", () => {
    const env = { SANDBOX_PROVIDER: "box", BOX_API_KEY: " box_key ", BOX_SNAPSHOT: "useagent-runtime", BOX_MACHINE_TYPE: "large" };
    expect(sandboxProviderKind(env)).toBe("box");
    expect(sandboxProviderApiKey(env)).toBe("box_key");
    expect(sandboxTemplate("DAYTONA_SNAPSHOT", env)).toBe("useagent-runtime");
    expect(sandboxTemplate("DAYTONA_SNAPSHOT", { SANDBOX_PROVIDER: "box" })).toBe("");
    expect(boxApiConfig("k", env)).toEqual({ apiKey: "k", apiUrl: "https://ascii.dev/api/box/v1", machineType: "large" });
    expect(() => boxApiConfig("k", { BOX_MACHINE_TYPE: "huge" })).toThrow(/BOX_MACHINE_TYPE/);
  });

  test("Box preview auth is the port-auth cookie, never a token header", () => {
    expect(sandboxPreviewHeaders("tok", "box")).toEqual({ cookie: "_port_auth=tok" });
  });
});

describe("sandbox preview authentication", () => {
  test("emits only Daytona preview authentication for Daytona", () => {
    expect(sandboxPreviewHeaders("preview-token", "daytona")).toEqual({
      "x-daytona-preview-token": "preview-token",
    });
  });

  test("supports Cube's E2B-compatible traffic token names", () => {
    expect(sandboxPreviewHeaders("preview-token", "cube")).toEqual({
      "cube-traffic-access-token": "preview-token",
      "e2b-traffic-access-token": "preview-token",
    });
  });

  test("does not emit empty credential headers", () => {
    expect(sandboxPreviewHeaders("")).toEqual({});
  });

  test("the computer-provider kinds are exactly the plugins that validate stored credentials", () => {
    const fromRegistry = SANDBOX_PROVIDER_KINDS.filter((kind) => sandboxPlugin(kind).validateCredential !== undefined);
    expect([...fromRegistry].sort()).toEqual([...COMPUTER_PROVIDER_KINDS].sort());
  });
});

describe("sandbox provider label", () => {
  test("the E2B-protocol plugin reads as E2B when its API URL points at e2b.app, else as its own label", () => {
    expect(sandboxProviderLabel("cube", { CUBE_API_URL: "https://api.e2b.app" })).toBe("E2B");
    expect(sandboxProviderLabel("cube", { CUBE_API_URL: "https://E2B.app/" })).toBe("E2B");
    expect(sandboxProviderLabel("cube", { CUBE_API_URL: "https://cube.internal.example:3000" })).toBe("Cube");
    expect(sandboxProviderLabel("cube", { CUBE_API_URL: "http://127.0.0.1:3000" })).toBe("Cube");
    // Unset or unparseable: the plugin's own label, never a thrown URL error.
    expect(sandboxProviderLabel("cube", {})).toBe("Cube");
    expect(sandboxProviderLabel("cube", { CUBE_API_URL: "not a url" })).toBe("Cube");
    // A lookalike host is not e2b.app.
    expect(sandboxProviderLabel("cube", { CUBE_API_URL: "https://e2b.app.evil.example" })).toBe("Cube");
    expect(sandboxProviderLabel("cube", { CUBE_API_URL: "https://notE2B.app" })).toBe("Cube");
  });

  test("the other kinds carry their plugin's label regardless of the URL", () => {
    expect(sandboxProviderLabel("daytona", { CUBE_API_URL: "https://api.e2b.app" })).toBe(sandboxPlugin("daytona").label);
    expect(sandboxProviderLabel("box", {})).toBe(sandboxPlugin("box").label);
  });
});

test("text a member reads never names the sandbox vendor", async () => {
  const { withoutSandboxVendor } = await import("./provider");
  expect(withoutSandboxVendor("Cube sandbox cube-1 failed readiness after 2 attempts")).toBe(
    "Cloud sandbox cube-1 failed readiness after 2 attempts",
  );
  expect(withoutSandboxVendor("Daytona has no default snapshot; E2B said 500")).toBe(
    "Cloud has no default snapshot; Cloud said 500",
  );
  expect(withoutSandboxVendor("Box terminals need the Box CLI installed")).toBe(
    "Cloud terminals need the Cloud CLI installed",
  );
  // An everyday "box" is not the vendor.
  expect(withoutSandboxVendor("Tick the Box above the reply box")).toBe("Tick the Box above the reply box");
});
