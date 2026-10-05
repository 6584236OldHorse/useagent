// The parts Docker and Apple containers share: both are driven through a
// command line tool with exec, spawn and a pseudo-terminal. Each backend
// supplies the tool name and the flags that differ.

import { BackendError, type DialedConnection, type ExecHandle, type ExecOptions, type ExecResult, type TerminalProcess } from "./types";

export interface CliFlags {
  readonly tool: string;
  /** Flags for `exec` that bind a user, a working directory and env. */
  execUser(user: string): readonly string[];
  execCwd(cwd: string): readonly string[];
  execEnv(key: string, value: string): readonly string[];
}

export async function runCli(
  argv: readonly string[],
  options: { readonly stdin?: Uint8Array; readonly timeoutMs?: number; readonly env?: Readonly<Record<string, string>> } = {},
): Promise<ExecResult> {
  const spawn = () =>
    Bun.spawn([...argv], {
      stdin: options.stdin ?? "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...options.env },
      ...(options.timeoutMs ? { timeout: options.timeoutMs, killSignal: "SIGKILL" } : {}),
    });
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn();
  } catch (error) {
    // A tool that is not installed answers like a failed command, so callers report it instead of crashing.
    return { exitCode: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false };
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const timedOut = options.timeoutMs !== undefined && proc.signalCode === "SIGKILL" && exitCode !== 0;
  return { exitCode, stdout, stderr, timedOut };
}

export function execArgv(flags: CliFlags, id: string, argv: readonly string[], options: ExecOptions & { interactive?: boolean; tty?: boolean } = {}): string[] {
  const out = [flags.tool, "exec"];
  if (options.interactive) out.push("-i");
  if (options.tty) out.push("-t");
  if (options.user) out.push(...flags.execUser(options.user));
  if (options.cwd) out.push(...flags.execCwd(options.cwd));
  for (const [key, value] of Object.entries(options.env ?? {})) out.push(...flags.execEnv(key, value));
  out.push(id, ...argv);
  return out;
}

export async function cliExec(flags: CliFlags, id: string, argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
  const result = await runCli(execArgv(flags, id, argv, { ...options, interactive: options.stdin !== undefined }), {
    stdin: options.stdin,
    timeoutMs: options.timeoutMs,
  });
  if (result.exitCode !== 0 && /No such container|not found|does not exist/i.test(result.stderr)) {
    throw new BackendError("not_found", result.stderr.trim());
  }
  return result;
}

export function cliSpawn(flags: CliFlags, id: string, argv: readonly string[], options: Omit<ExecOptions, "stdin" | "timeoutMs"> = {}): ExecHandle {
  const proc = Bun.spawn(execArgv(flags, id, argv, { ...options, interactive: true }), {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdin = proc.stdin;
  return {
    stdout: proc.stdout,
    stderr: proc.stderr,
    async writeStdin(bytes) {
      stdin.write(bytes);
      await stdin.flush();
    },
    endStdin() {
      try {
        stdin.end();
      } catch {
        /* already closed */
      }
    },
    exited: proc.exited,
    kill() {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

export function cliSpawnTerminal(
  flags: CliFlags,
  id: string,
  argv: readonly string[],
  terminal: Bun.Terminal,
  options: Omit<ExecOptions, "stdin" | "timeoutMs"> = {},
): TerminalProcess {
  const proc = Bun.spawn(execArgv(flags, id, argv, { ...options, interactive: true, tty: true }), { terminal });
  return {
    exited: proc.exited,
    kill() {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

/** No host port is published: socat inside the container bridges the exec's stdio to the port, so a port bound to the container's loopback is reachable. */
export function cliDial(flags: CliFlags, id: string, port: number): DialedConnection {
  const handle = cliSpawn(flags, id, ["socat", "-", `TCP:127.0.0.1:${port}`]);
  const { promise: closed, resolve } = Promise.withResolvers<void>();
  void handle.exited.then(() => resolve());
  return {
    readable: handle.stdout,
    write: (bytes) => handle.writeStdin(bytes),
    end: () => handle.endStdin(),
    close: () => handle.kill(),
    closed,
  };
}

/** `docker inspect`-style JSON: one object per id, or null when absent. */
export function firstJsonObject(stdout: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return first && typeof first === "object" ? (first as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
