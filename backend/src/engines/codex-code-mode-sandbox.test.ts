import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildCodexCodeModeLaunchCommand,
  buildCodexCodeModeTokenCommand,
  codexCodeModeOwners,
  codexCodeModeSandboxPaths,
} from "./codex-code-mode-sandbox";
import { buildSandboxListenerProbeCommand, readListenerVerdicts } from "./sandbox-listener-probe";

const PROC_TCP_HEADER = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";

describe("Codex code-mode host in the sandbox", () => {
  test("recognises the host and forwarder by the processes that own their ports", async () => {
    const home = await mkdtemp(join(tmpdir(), "useagent-code-mode-owners-"));
    const layout = { home, workdir: `${home}/work`, runsAsRoot: false, bunExecutable: `${home}/bin/bun` };
    const paths = codexCodeModeSandboxPaths(layout);
    const host = `${paths.nativeRoot}/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex-code-mode-host`;
    await mkdir(dirname(host), { recursive: true });
    await mkdir(`${home}/bin`, { recursive: true });
    await writeFile(host, "");
    await writeFile(layout.bunExecutable, "");
    const [hostOwner, forwarderOwner] = codexCodeModeOwners(layout);

    const procRoot = async (forwarderArgs: readonly string[]) => {
      const proc = await mkdtemp(join(home, "proc-"));
      await mkdir(join(proc, "net"));
      // 0x9368 = 37736 (host, loopback), 0x9369 = 37737 (forwarder, all interfaces).
      await writeFile(join(proc, "net/tcp"), PROC_TCP_HEADER +
        "   0: 0100007F:9368 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5001 1\n" +
        "   1: 00000000:9369 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 5002 1\n");
      const process = async (pid: number, inode: number, exe: string, args: readonly string[]) => {
        await mkdir(join(proc, `${pid}/fd`), { recursive: true });
        await symlink(`socket:[${inode}]`, join(proc, `${pid}/fd/7`));
        await symlink(exe, join(proc, `${pid}/exe`));
        await writeFile(join(proc, `${pid}/cmdline`), `${[exe, ...args].join("\0")}\0`);
      };
      await process(41, 5001, host, hostOwner!.args);
      await process(42, 5002, layout.bunExecutable, forwarderArgs);
      return proc;
    };
    const probe = async (forwarderArgs: readonly string[]) => {
      const result = spawnSync("sh", ["-c", `${buildSandboxListenerProbeCommand([hostOwner!, forwarderOwner!], 0)} ${await procRoot(forwarderArgs)}`]);
      return { status: result.status, verdicts: readListenerVerdicts(result.stdout.toString(), [hostOwner!, forwarderOwner!]) };
    };

    expect(await probe(forwarderOwner!.args)).toEqual({ status: 0, verdicts: { 37736: 0, 37737: 0 } });
    expect(await probe([`${home}/evil.js`, ...forwarderOwner!.args.slice(1)])).toEqual({ status: 2, verdicts: { 37736: 0, 37737: 2 } });
  });

  test("starts only what is missing, and the host replaces the launching shell", () => {
    const layout = { home: "/root", workdir: "/root/work", runsAsRoot: true, bunExecutable: "/usr/local/bin/bun" };
    const both = buildCodexCodeModeLaunchCommand(layout, { host: true, forwarder: true });
    expect(both).toContain('"/usr/local/bin/bun" "/root/.useagent/code-mode-forwarder.js" "37737" "37736" "/root/.useagent/code-mode-forwarder.sha256" &');
    expect(both).toContain('"/usr/local/share/useagent/native-engines"/node_modules/@openai/codex-linux-*/vendor/*/bin/codex-code-mode-host');
    expect(both).toContain('exec "$CODE_MODE_HOST" "--listen" "grpc://127.0.0.1:37736"');
    const forwarderOnly = buildCodexCodeModeLaunchCommand(layout, { host: false, forwarder: true });
    expect(forwarderOnly).not.toContain("CODE_MODE_HOST");
    expect(forwarderOnly.trim().endsWith("wait")).toBe(true);
    const hostOnly = buildCodexCodeModeLaunchCommand(layout, { host: true, forwarder: false });
    expect(hostOnly).not.toContain("code-mode-forwarder.js\" \"37737\"");
  });

  test("writes only a well-formed bearer digest", () => {
    const layout = { home: "/root", workdir: "/root/work", runsAsRoot: true };
    expect(buildCodexCodeModeTokenCommand("a".repeat(64), layout)).toContain("code-mode-forwarder.sha256");
    for (const digest of ["", "A".repeat(64), "a".repeat(63), `${"a".repeat(63)};`]) {
      expect(() => buildCodexCodeModeTokenCommand(digest, layout)).toThrow("digest");
    }
  });
});
