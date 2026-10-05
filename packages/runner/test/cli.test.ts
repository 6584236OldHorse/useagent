import { describe, expect, test } from "bun:test";
import { EXIT, defaultDataDir, parseArgs, runnerIdFromToken } from "../src/cli";

describe("command line", () => {
  test("run needs a plane URL and normalises it to an origin", () => {
    const command = parseArgs(["--plane", "https://app.useagent.org/anything?x=1"], {});
    expect(command).toMatchObject({ command: "run", planeUrl: "https://app.useagent.org", backend: "auto", shareLogins: [], maxSandboxes: 4 });
  });

  test("reads every option", () => {
    const command = parseArgs(["--plane", "http://127.0.0.1:3201", "--backend", "docker", "--share-logins", "codex, claude", "--max-sandboxes", "2", "--data-dir", "/tmp/r"], {});
    expect(command).toEqual({
      command: "run",
      planeUrl: "http://127.0.0.1:3201",
      backend: "docker",
      shareLogins: ["codex", "claude"],
      maxSandboxes: 2,
      dataDir: "/tmp/r",
    });
  });

  test("rejects what it does not understand", () => {
    expect(() => parseArgs([], {})).toThrow(/--plane/);
    expect(() => parseArgs(["--plane", "ftp://x"], {})).toThrow(/http/);
    expect(() => parseArgs(["--plane", "not a url"], {})).toThrow(/not a URL/);
    expect(() => parseArgs(["--plane", "https://x", "--backend", "podman"], {})).toThrow(/auto, docker or apple/);
    expect(() => parseArgs(["--plane", "https://x", "--max-sandboxes", "0"], {})).toThrow(/positive/);
    expect(() => parseArgs(["--plane", "https://x", "--token", "abc"], {})).toThrow(/unknown argument/);
    expect(() => parseArgs(["--plane"], {})).toThrow(/needs a value/);
  });

  test("uninstall, version and help", () => {
    expect(parseArgs(["uninstall", "--backend", "apple"], {})).toMatchObject({ command: "uninstall", backend: "apple" });
    expect(parseArgs(["--version"], {})).toEqual({ command: "version" });
    expect(parseArgs(["--help"], {})).toEqual({ command: "help" });
  });

  test("the plane URL may come from the environment", () => {
    expect(parseArgs([], { USEAGENT_PLANE_URL: "https://plane.example" })).toMatchObject({ planeUrl: "https://plane.example" });
  });

  test("exit codes match the contract with the shell", () => {
    expect(EXIT).toEqual({ ok: 0, usage: 1, tokenRejected: 2, noBackend: 3, planeTooOld: 4, runnerTooOld: 5 });
  });

  test("data directory per platform", () => {
    expect(defaultDataDir("/Users/me", "darwin")).toBe("/Users/me/Library/Application Support/useagent-runner");
    expect(defaultDataDir("/home/me", "linux")).toMatch(/useagent-runner$/);
  });
});

describe("runner tokens", () => {
  test("carry the runner id", () => {
    expect(runnerIdFromToken("uart_rn_01HZX.s3cr3t-value_9")).toBe("rn_01HZX");
    expect(runnerIdFromToken(" uart_abc.def \n")).toBe("abc");
  });

  test("anything else is not a runner token", () => {
    expect(runnerIdFromToken("")).toBeNull();
    expect(runnerIdFromToken("uak_abc")).toBeNull();
    expect(runnerIdFromToken("uart_abc")).toBeNull();
    expect(runnerIdFromToken("uart_a:b.c")).toBeNull();
  });
});
