import { describe, expect, test } from "bun:test";
import { buildRuntimeEnvironmentBootScript, runtimeEnvironmentBootPath } from "./runtime-environment-boot";
import { buildRuntimeEnvironmentAuthenticationCommand } from "./runtime-environment-client";
import { buildRuntimeEnvironmentLaunchCommand, buildRuntimeEnvironmentReadinessCommand } from "./runtime-environment";

describe("sandbox boot entrypoint", () => {
  const env = { RUNTIME_CODEX_CHILD_EVENT_FORWARDING: "1" };
  const script = buildRuntimeEnvironmentBootScript(env);

  test("starts the plane's exact launch command in the background, waits on the plane's readiness probe, pairs, warms the shell and keeps the container alive", () => {
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    const single = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    expect(script).toContain(`nohup sh -c ${single(buildRuntimeEnvironmentLaunchCommand(env))} >"/root/.skynet/t3/boot.log" 2>&1 &`);
    expect(script).toContain(`until sh -c ${single(buildRuntimeEnvironmentReadinessCommand(env))}; do`);
    expect(script).toContain(`sh -c ${single(buildRuntimeEnvironmentAuthenticationCommand())} >>"/root/.skynet/t3/boot.log" 2>&1 || true`);
    expect(script).toContain("http://127.0.0.1:37733/api/orchestration/shell || true");
    expect(script.trimEnd().endsWith('[ "$#" -gt 0 ] && exec "$@"\nexec sleep infinity')).toBe(true);
    // The plane sees the boot in progress from the moment before the launch until readiness passed or the wait gave up.
    expect(script.indexOf('touch "$HOME/.skynet/t3/.useagent-runtime-booting"')).toBeLessThan(script.indexOf("nohup sh -c"));
    expect(script.indexOf('rm -f "$HOME/.skynet/t3/.useagent-runtime-booting"')).toBeGreaterThan(script.indexOf("done\n"));
    // The wait is bounded: a runtime that never comes up leaves the sandbox idle for the plane to repair.
    expect(script).toContain('[ "$i" -ge 600 ] && break');
  });

  test("the flags the runtime starts with follow the plane's environment at bake time", () => {
    expect(script).toContain('"child-forwarding=on" > "/root/.skynet/t3/.useagent-runtime-flags"');
    expect(buildRuntimeEnvironmentBootScript({})).toContain('"child-forwarding=off" > "/root/.skynet/t3/.useagent-runtime-flags"');
  });

  test("a non-root layout boots from its own home", () => {
    const layout = { home: "/home/user", workdir: "/home/user/work", runsAsRoot: false };
    expect(runtimeEnvironmentBootPath(layout)).toBe("/home/user/.local/bin/useagent-sandbox-boot");
    const local = buildRuntimeEnvironmentBootScript({}, layout);
    expect(local).toContain('export HOME="/home/user"');
    expect(local).toContain('>"/home/user/.skynet/t3/boot.log"');
    expect(local).not.toContain("/root/");
  });
});
