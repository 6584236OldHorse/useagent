import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SandboxHandle, SandboxExecuteResult } from "../sandboxes/provider";
import type { CodexSubscriptionRelayBinding } from "../provider-connections/codex-subscription-relay";
import type { CodexSubscriptionRuntimeSelection } from "../provider-connections/service";
import type { ProviderThreadBindingScope } from "../provider-connections/repo";
import type { EngineRunContext } from "./types";
import {
  awaitCodexProviderReady,
  buildCodexExecServerCommand,
  buildCodexExecServerReadinessCommand,
  buildCodexProviderInstanceCommand,
  buildCodexProviderReadyProbeCommand,
  codexExecServerOwner,
  prepareCodexSubscription,
  previewWebSocketUrl,
} from "./codex-subscription-runtime";

const priorGatewayUrl = process.env.PROVIDER_GATEWAY_PUBLIC_URL;
const priorGatewaySecret = process.env.PROVIDER_GATEWAY_SECRET;

beforeEach(() => {
  process.env.PROVIDER_GATEWAY_PUBLIC_URL = "https://gateway.example.test";
  process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
});

afterEach(() => {
  if (priorGatewayUrl === undefined) delete process.env.PROVIDER_GATEWAY_PUBLIC_URL;
  else process.env.PROVIDER_GATEWAY_PUBLIC_URL = priorGatewayUrl;
  if (priorGatewaySecret === undefined) delete process.env.PROVIDER_GATEWAY_SECRET;
  else process.env.PROVIDER_GATEWAY_SECRET = priorGatewaySecret;
});

describe("T3 Codex subscription lease", () => {
  test("binds the host relay to the exact run and remote execution environment", async () => {
    const harness = fakeSandbox();
    const closed: string[] = [];
    let relayBinding: CodexSubscriptionRelayBinding | undefined;
    let relayRuntime: CodexSubscriptionRuntimeSelection | undefined;
    let relayExecServerUrl: string | undefined;
    let threadBindingScope: ProviderThreadBindingScope | undefined;

    const lease = await prepareCodexSubscription({
      sandbox: harness.sandbox,
      ctx: context(),
      workdir: "/root/work",
      runtime: runtime(),
      dependencies: {
        loadThreadBinding: async (scope) => {
          threadBindingScope = scope;
          return "provider-thread-1";
        },
        openExecBridge: (input) => {
          expect(input).toEqual({
            upstreamUrl: "wss://preview.example.test/",
            expectedUpstreamHost: "preview.example.test",
            headers: { "x-daytona-preview-token": "preview-secret" },
          });
          return { url: "ws://127.0.0.1:43111/grant", close: () => closed.push("bridge") };
        },
        issueRelay: (input) => {
          relayBinding = input.binding;
          relayRuntime = input.runtime;
          relayExecServerUrl = input.execServerUrl;
          return {
            url: "wss://useagent.example.test/api/internal/codex-relay/opaque",
            close: () => closed.push("relay"),
          };
        },
      },
    });

    expect(harness.createdSessions).toEqual(["skynet-codex-exec-server", "skynet-codex-code-mode"]);
    expect(harness.sessionCommands).toHaveLength(2);
    expect(harness.sessionCommands[0]?.command).toContain(
      '"/usr/local/bin/codex" exec-server --listen ws://0.0.0.0:37734',
    );
    expect(harness.sessionCommands[1]?.command).toContain('"--listen" "grpc://127.0.0.1:37736"');
    expect(harness.previewPorts).toEqual([37_734, 37_737]);
    expect(relayBinding).toEqual({
      orgId: "org-1",
      userId: "user-1",
      threadId: "thread-1",
      runId: "run-1",
      connectionId: "connection-1",
      authEpoch: "credential-generation-123",
      model: "gpt-5.5",
      sandboxId: "sandbox-1",
      sandboxGeneration: "useagent-runtime-v8",
      environmentId: "skynet-sandbox-1-run-1",
      cwd: "/root/work",
    });
    expect(relayRuntime).toEqual(runtime());
    expect(relayExecServerUrl).toBe("ws://127.0.0.1:43111/grant");
    expect(lease.authEpoch).toBe("credential-generation-123");
    expect(lease.hasCurrentEpochThreadBinding).toBe(true);
    expect(threadBindingScope).toEqual({
      orgId: "org-1",
      userId: "user-1",
      productThreadId: "thread-1",
      connectionId: "connection-1",
      authEpoch: "credential-generation-123",
    });

    const providerPatch = harness.commands.find(({ command }) =>
      command.includes("CODEX_INSTANCE_B64"),
    )?.command ?? "";
    expect(providerPatch).toContain("CODEX_INSTANCE_B64");
    expect(providerPatch).not.toContain("/host/codex-home");
    expect(providerPatch).not.toContain("preview-secret");
    expect(providerPatch).not.toContain("USEAGENT_TOOL_GATEWAY_BEARER_TOKEN");
    expect(
      harness.commands.some(({ command }) => command.includes("provider-gateway-generation")),
    ).toBe(true);

    await lease.close();
    await lease.close();

    expect(closed).toEqual(["relay", "bridge"]);
    expect(harness.deletedSessions).toEqual([
      "skynet-codex-exec-server",
      "skynet-codex-exec-server",
    ]);
    expect(harness.commands.at(-1)?.command).toContain(
      "delete current.providerInstances.codex",
    );
  });

  test("reuses the exec server an earlier turn left listening", async () => {
    const harness = fakeSandbox({ execServerListening: true, codeModeListening: true });
    let relayExecServerUrl: string | undefined;

    const lease = await prepareCodexSubscription({
      sandbox: harness.sandbox,
      ctx: context(),
      workdir: "/root/work",
      runtime: runtime(),
      dependencies: {
        loadThreadBinding: async () => null,
        openExecBridge: () => ({ url: "ws://127.0.0.1:43111/grant", close() {} }),
        issueRelay: (input) => {
          relayExecServerUrl = input.execServerUrl;
          return { url: "wss://useagent.example.test/api/internal/codex-relay/opaque", close() {} };
        },
      },
    });

    expect(harness.deletedSessions).toEqual([]);
    expect(harness.createdSessions).toEqual([]);
    expect(harness.sessionCommands).toEqual([]);
    expect(harness.previewPorts).toEqual([37_734, 37_737]);
    expect(relayExecServerUrl).toBe("ws://127.0.0.1:43111/grant");
    expect(harness.commands[0]?.command).toContain("code-mode-forwarder.sha256");
    expect(harness.commands[0]?.command).toContain("const deadline=Date.now()+0;");
    expect(harness.commands).toHaveLength(3);
    expect(harness.commands.some(({ command }) => command.includes("CODEX_INSTANCE_B64"))).toBe(true);
    expect(
      harness.commands.some(({ command }) => command.includes("provider-gateway-generation")),
    ).toBe(true);

    await lease.close();
  });

  test("readiness accepts only the installed Codex exec-server as the port's owner", async () => {
    const home = await mkdtemp(join(tmpdir(), "useagent-exec-identity-"));
    const layout = { home, workdir: `${home}/work`, runsAsRoot: false, bunExecutable: "/usr/local/bin/bun" };
    const native = `${home}/.local/share/useagent/native-engines/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`;
    const foreign = `${home}/python3`;
    await mkdir(dirname(native), { recursive: true });
    await writeFile(native, "");
    await writeFile(foreign, "");
    const procRoot = async (owner?: { exe: string; args: readonly string[] }) => {
      const proc = await mkdtemp(join(home, "proc-"));
      await mkdir(join(proc, "net"));
      const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
      await writeFile(join(proc, "net/tcp"), header + (owner
        ? "   0: 00000000:9366 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4242 1 0 100 0 0 10 0\n"
        : ""));
      if (owner) {
        await mkdir(join(proc, "77/fd"), { recursive: true });
        await symlink("socket:[4242]", join(proc, "77/fd/3"));
        await symlink(owner.exe, join(proc, "77/exe"));
        await writeFile(join(proc, "77/cmdline"), `${owner.args.join("\0")}\0`);
      }
      return proc;
    };
    const probe = async (owner?: { exe: string; args: readonly string[] }) =>
      spawnSync("sh", ["-c", `${buildCodexExecServerReadinessCommand(0, layout)} ${await procRoot(owner)}`]).status;
    const listening = ["codex", "exec-server", "--listen", "ws://0.0.0.0:37734", "--environment-id", "skynet-run-1"];

    expect(await probe()).toBe(1);
    expect(await probe({ exe: native, args: listening })).toBe(0);
    expect(await probe({ exe: foreign, args: listening })).toBe(2);
    expect(await probe({ exe: native, args: ["codex", "app-server", "--listen", "ws://0.0.0.0:37734"] })).toBe(2);
  });

  test("points the app-server's code mode at the sandbox host through this run's bearer", async () => {
    const harness = fakeSandbox({ execServerListening: true });
    let bridgeInput: Parameters<typeof import("../provider-connections/codex-code-mode-bridge").openCodexCodeModeBridge>[0] | undefined;
    let relayCodeModeUrl: string | undefined;

    const lease = await prepareCodexSubscription({
      sandbox: harness.sandbox,
      ctx: context(),
      workdir: "/root/work",
      runtime: runtime(),
      dependencies: {
        loadThreadBinding: async () => null,
        openExecBridge: () => ({ url: "ws://127.0.0.1:43111/grant", close() {} }),
        openCodeModeBridge: (input) => {
          bridgeInput = input;
          return { url: "http://127.0.0.1:43112", close() {} };
        },
        issueRelay: (input) => {
          relayCodeModeUrl = input.codeModeHostUrl;
          return { url: "wss://useagent.example.test/api/internal/codex-relay/opaque", close() {} };
        },
      },
    });

    // Only the code-mode host and forwarder were missing; the exec-server was reused.
    expect(harness.createdSessions).toEqual(["skynet-codex-code-mode"]);
    expect(harness.sessionCommands[0]?.command).toContain("code-mode-forwarder.js");
    expect(relayCodeModeUrl).toBe("http://127.0.0.1:43112");
    expect(bridgeInput?.upstreamUrl).toBe("wss://preview.example.test/");
    expect(bridgeInput?.bearerToken).toMatch(/^[0-9a-f]{64}$/);
    const digest = createHash("sha256").update(bridgeInput!.bearerToken).digest("hex");
    expect(harness.commands[0]?.command).toContain(digest);
    expect(harness.commands[0]?.command).not.toContain(bridgeInput!.bearerToken);

    await lease.close();
  });

  test("fails the turn when another process holds the exec-server port", async () => {
    const harness = fakeSandbox({ execServerPortForeign: true });
    let relayIssued = false;

    await expect(prepareCodexSubscription({
      sandbox: harness.sandbox,
      ctx: context(),
      workdir: "/root/work",
      runtime: runtime(),
      dependencies: {
        loadThreadBinding: async () => null,
        openExecBridge: () => {
          throw new Error("bridge must not open");
        },
        issueRelay: () => {
          relayIssued = true;
          throw new Error("relay must not issue");
        },
      },
    })).rejects.toThrow("another process");

    expect(relayIssued).toBe(false);
    expect(harness.sessionCommands).toEqual([]);
  });

  test("launches Box Codex through the installed absolute binary", async () => {
    const harness = fakeSandbox({ providerKind: "box" });
    const lease = await prepareCodexSubscription({
      sandbox: harness.sandbox,
      ctx: context(),
      workdir: "/home/user/work",
      runtime: runtime(),
      dependencies: {
        loadThreadBinding: async () => null,
        openExecBridge: () => ({
          url: "ws://127.0.0.1:43111/grant",
          close() {},
        }),
        issueRelay: () => ({
          url: "wss://useagent.example.test/api/internal/codex-relay/opaque",
          close() {},
        }),
      },
    });

    expect(harness.sessionCommands[0]?.command).toContain(
      'exec "/home/user/.local/bin/codex" exec-server',
    );
    expect(harness.sessionCommands[0]?.command).not.toContain("exec codex ");
    expect(lease.hasCurrentEpochThreadBinding).toBe(false);

    const patch = buildCodexProviderInstanceCommand({
      relayUrl: "wss://useagent.example.test/api/internal/codex-relay/opaque",
      environmentId: "skynet-run-1",
      workdir: "/home/user/work",
    }, {
      home: "/home/user",
      workdir: "/home/user/work",
      runsAsRoot: false,
      bunExecutable: "/usr/local/bin/bun",
    });
    const encoded = patch.match(/CODEX_INSTANCE_B64='([^']+)'/)?.[1] ?? "";
    const instance = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
      config?: { binaryPath?: string };
    };
    expect(instance.config?.binaryPath).toBe("/home/user/.local/bin/codex");

    await lease.close();
  });

  test("unwinds the exec server and bridges when provider configuration fails", async () => {
    const harness = fakeSandbox({ failProviderPatch: true });
    const closed: string[] = [];

    await expect(prepareCodexSubscription({
      sandbox: harness.sandbox,
      ctx: context(),
      workdir: "/root/work",
      runtime: runtime(),
      dependencies: {
        loadThreadBinding: async () => null,
        openExecBridge: () => ({
          url: "ws://127.0.0.1:43111/grant",
          close: () => closed.push("bridge"),
        }),
        issueRelay: () => ({
          url: "wss://useagent.example.test/api/internal/codex-relay/opaque",
          close: () => closed.push("relay"),
        }),
      },
    })).rejects.toThrow("provider configuration failed");

    expect(closed).toEqual(["relay", "bridge"]);
    expect(harness.deletedSessions).toEqual([
      "skynet-codex-exec-server",
      "skynet-codex-exec-server",
    ]);
  });

  test("removes a session when the exec server launch fails", async () => {
    const harness = fakeSandbox({ launchExit: 127 });
    let relayIssued = false;

    await expect(prepareCodexSubscription({
      sandbox: harness.sandbox,
      ctx: context(),
      workdir: "/root/work",
      runtime: runtime(),
      dependencies: {
        loadThreadBinding: async () => null,
        openExecBridge: () => {
          throw new Error("bridge must not open");
        },
        issueRelay: () => {
          relayIssued = true;
          throw new Error("relay must not issue");
        },
      },
    })).rejects.toThrow("Codex exec-server failed to start");

    expect(relayIssued).toBe(false);
    expect(harness.deletedSessions).toEqual([
      "skynet-codex-exec-server",
      "skynet-codex-exec-server",
    ]);
  });

  test("fails closed before minting a capability without tenant identity", async () => {
    const harness = fakeSandbox();
    let issued = false;

    await expect(prepareCodexSubscription({
      sandbox: harness.sandbox,
      ctx: { ...context(), orgId: null },
      workdir: "/root/work",
      runtime: runtime(),
      dependencies: {
        loadThreadBinding: async () => {
          throw new Error("thread binding lookup must not run");
        },
        openExecBridge: () => ({
          url: "ws://127.0.0.1:43111/grant",
          close() {},
        }),
        issueRelay: () => {
          issued = true;
          throw new Error("unreachable");
        },
      },
    })).rejects.toThrow("organization identity is required");

    expect(issued).toBe(false);
    expect(harness.createdSessions).toEqual([]);
    expect(harness.deletedSessions).toEqual([]);
  });

  test("builds shell-safe commands with no host credential material", () => {
    expect(buildCodexExecServerCommand("skynet-run-1")).toBe(
      [
        "set -eu",
        'exec "/usr/local/bin/codex" exec-server --listen ws://0.0.0.0:37734 --environment-id skynet-run-1',
      ].join("\n"),
    );
    expect(buildCodexExecServerCommand("skynet-run-1")).not.toContain("update_plan");
    expect(() => buildCodexExecServerCommand("unsafe; touch /tmp/pwned")).toThrow(
      "environment id is unsafe",
    );
    expect(codexExecServerOwner().args).toEqual(["exec-server", "--listen", "ws://0.0.0.0:37734"]);

    const patch = buildCodexProviderInstanceCommand({
      relayUrl: "wss://useagent.example.test/api/internal/codex-relay/opaque",
      environmentId: "skynet-run-1",
      workdir: "/root/work",
    });
    expect(patch).not.toContain("CODEX_HOME");
    expect(patch).not.toContain("access_token");
    expect(patch).not.toContain("refresh_token");
  });

  test("accepts only the configured Cube preview domain", () => {
    const env = { CUBE_SANDBOX_DOMAIN: "sandbox.example.com", NODE_ENV: "test" };
    expect(previewWebSocketUrl(
      "https://37734-sandbox-1.sandbox.example.com/exec",
      "cube",
      env,
    )).toBe("wss://37734-sandbox-1.sandbox.example.com/exec");
    expect(() => previewWebSocketUrl(
      "https://37734-sandbox-1.attacker.example/exec",
      "cube",
      env,
    )).toThrow("outside the Cube sandbox domain");
  });

  test("readiness probe keys on the subscription instance display name in the cache", () => {
    const command = buildCodexProviderReadyProbeCommand();
    // Reads the status cache CONTENT (not mtime) for the subscription-only marker.
    expect(command).toContain("caches/codex.json");
    expect(command).toContain("displayName");
    expect(command).toContain("Codex subscription");
    // The probe marker matches the display name the provider-instance patch sets.
    const patch = buildCodexProviderInstanceCommand({
      relayUrl: "wss://useagent.example.test/api/internal/codex-relay/opaque",
      environmentId: "skynet-run-1",
      workdir: "/root/work",
    });
    const encoded = patch.match(/CODEX_INSTANCE_B64='([^']+)'/)?.[1] ?? "";
    const instance = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
      displayName?: string;
    };
    expect(instance.displayName).toBe("Codex subscription");
  });

  test("readiness barrier confirms once the status cache reports the remote instance", async () => {
    let ready = false;
    const commands: string[] = [];
    const sandbox = {
      process: {
        async executeCommand(command: string) {
          commands.push(command);
          return { exitCode: ready ? 0 : 1 } satisfies Partial<SandboxExecuteResult>;
        },
      },
    } as unknown as SandboxHandle;

    // A zero-length deadline that never confirms falls back (returns false).
    await expect(
      awaitCodexProviderReady(sandbox, new AbortController().signal, 0),
    ).resolves.toBe(false);
    // Once the cache reports the subscription instance, the barrier confirms.
    ready = true;
    await expect(
      awaitCodexProviderReady(sandbox, new AbortController().signal, 0),
    ).resolves.toBe(true);
    expect(commands.every((command) => command.includes("caches/codex.json"))).toBe(true);
  });

  test("readiness barrier stops immediately when the run is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const sandbox = {
      process: {
        async executeCommand() {
          calls += 1;
          return { exitCode: 1 } satisfies Partial<SandboxExecuteResult>;
        },
      },
    } as unknown as SandboxHandle;

    await expect(
      awaitCodexProviderReady(sandbox, controller.signal, 5_000),
    ).resolves.toBe(false);
    expect(calls).toBe(0);
  });
});

function context(): EngineRunContext {
  return {
    runId: "run-1",
    threadId: "thread-1",
    orgId: "org-1",
    userId: "user-1",
    model: "gpt-5.5",
    prompt: "hello",
    bootstrapContext: "",
    turnContext: "",
    workdir: "/root/work",
    signal: new AbortController().signal,
    async emit() {
      return undefined;
    },
    setSummary() {},
  };
}

function runtime(): CodexSubscriptionRuntimeSelection {
  return {
    authMethod: "chatgpt_oauth",
    mode: "managed_codex_app_server",
    connectionId: "connection-1",
    authEpoch: "credential-generation-123",
    codexHome: "/host/codex-home",
    metadata: { email: "me@example.test", planType: "pro" },
  };
}

function fakeSandbox(options: {
  execServerListening?: boolean;
  execServerPortForeign?: boolean;
  codeModeListening?: boolean;
  failProviderPatch?: boolean;
  launchExit?: number;
  providerKind?: "box" | "cube" | "daytona";
} = {}) {
  const commands: Array<{ command: string; result: SandboxExecuteResult }> = [];
  const createdSessions: string[] = [];
  const deletedSessions: string[] = [];
  const sessionCommands: Array<{ sessionId: string; command: string }> = [];
  const previewPorts: number[] = [];
  const sandbox = {
    id: "sandbox-1",
    ...(options.providerKind ? { providerKind: options.providerKind } : {}),
    cpu: 2,
    memory: 4,
    process: {
      async executeCommand(command: string) {
        const providerPatch = command.includes("CODEX_INSTANCE_B64");
        const quickProbe = command.includes("const deadline=Date.now()+0;");
        const readinessProbe = command.includes("const deadline=Date.now()+15000;");
        if (quickProbe || readinessProbe) {
          const owners = JSON.parse(Buffer.from(command.trim().split(" ").at(-1) ?? "", "base64").toString("utf8")) as Array<{ port: number }>;
          const verdicts = Object.fromEntries(owners.map(({ port }) => [port, readinessProbe
            ? 0
            : port === 37_734
              ? options.execServerPortForeign ? 2 : options.execServerListening ? 0 : 1
              : options.codeModeListening ? 0 : 1]));
          const values = Object.values(verdicts);
          const result = { exitCode: values.includes(2) ? 2 : values.every((v) => v === 0) ? 0 : 1, result: JSON.stringify(verdicts) };
          commands.push({ command, result });
          return result;
        }
        const result = { exitCode: providerPatch && options.failProviderPatch ? 1 : 0 };
        commands.push({ command, result });
        return result;
      },
      async createSession(sessionId: string) {
        createdSessions.push(sessionId);
      },
      async deleteSession(sessionId: string) {
        deletedSessions.push(sessionId);
      },
      async executeSessionCommand(sessionId: string, request: { command: string }) {
        sessionCommands.push({ sessionId, command: request.command });
        return { cmdId: "cmd-1", exitCode: options.launchExit ?? 0 };
      },
    },
    async getPreviewLink(port: number) {
      previewPorts.push(port);
      return {
        url: options.providerKind === "box"
          ? "https://sandbox-37734.on.ascii.dev"
          : "https://preview.example.test",
        token: "preview-secret",
      };
    },
  } as unknown as SandboxHandle;
  return {
    sandbox,
    commands,
    createdSessions,
    deletedSessions,
    sessionCommands,
    previewPorts,
  };
}
