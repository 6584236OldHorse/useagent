// Process sessions inside a container, the shape the control plane's
// SandboxProcess expects: a named session holds commands; a command runs
// synchronously with captured output, or detached with a log file, a pid file
// and an exit file so its status survives the runner restarting. Detached
// commands also get a FIFO on stdin, which is what Pi's RPC transport writes to.
//
// The same layout Box uses, so every engine's session behaviour carries over.

import type { LocalSessionCommand, LocalSessionExecuteResult } from "@useagent/runner-protocol";
import { BackendError, type LocalBackend } from "./backends/types";

export const SESSION_ROOT = "/tmp/useagent/sessions";
const SYNC_COMMAND_CAP_SECONDS = 600;
const CONTROL_TIMEOUT_MS = 30_000;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Ids are single path segments; the service refuses anything else before it gets here. */
function segment(id: string): string {
  if (!id || id.includes("/") || id.includes("..") || id.includes("\0")) throw new BackendError("internal", `${JSON.stringify(id)} is not a plain identifier`);
  return id;
}

export function sessionDir(sessionId: string): string {
  return `${SESSION_ROOT}/${segment(sessionId)}`;
}

function commandBase(sessionId: string, commandId: string): string {
  return `${sessionDir(sessionId)}/${segment(commandId)}`;
}

/** Launcher for a detached command: records its pid, keeps a FIFO open for stdin, writes the exit code last. */
export function detachedLaunchScript(base: string, sessionId: string, commandId: string): string {
  return [
    "#!/bin/sh",
    `exec 3<>${shellQuote(`${base}.in`)}`,
    `printf '%s\\n' "$$" > ${shellQuote(`${base}.pid`)}`,
    `export USEAGENT_SESSION_ID=${shellQuote(sessionId)} USEAGENT_COMMAND_ID=${shellQuote(commandId)}`,
    `sh ${shellQuote(`${base}.sh`)} <&3 >${shellQuote(`${base}.log`)} 2>&1`,
    "code=$?",
    `printf '%s\\n' "$code" > ${shellQuote(`${base}.exit`)}`,
    "exit 0",
    "",
  ].join("\n");
}

/**
 * Every launcher ran under setsid, so its pid is a session id. Walk /proc and
 * TERM every process in those sessions (dash's kill cannot address a process
 * group, and procps may be absent), then the leaders themselves.
 */
export function killSessionScript(dir: string): string {
  return [
    // A command that already wrote its exit code is gone; its pid may belong to someone else by now.
    `for f in ${shellQuote(dir)}/*.pid; do [ -e "$f" ] || continue; [ -e "\${f%.pid}.exit" ] && continue; p=$(cat "$f"); case "$p" in ''|*[!0-9]*) continue;; esac`,
    `for st in /proc/[0-9]*/stat; do pid=\${st#/proc/}; pid=\${pid%/stat}; rest=$(sed 's/^.*) //' "$st" 2>/dev/null) || continue; set -- $rest; [ "$4" = "$p" ] && kill -TERM "$pid" 2>/dev/null; done`,
    `kill -TERM "$p" 2>/dev/null; done`,
  ].join("; ");
}

export interface SessionEnvironment {
  readonly user: string;
  readonly home: string;
  readonly workdir: string;
}

export class SessionManager {
  constructor(
    private readonly backend: LocalBackend,
    private readonly env: SessionEnvironment,
  ) {}

  private async sh(sandboxId: string, script: string, options: { stdin?: Uint8Array; timeoutMs?: number; cwd?: string } = {}) {
    const result = await this.backend.exec(sandboxId, ["sh", "-c", script], {
      user: this.env.user,
      cwd: options.cwd ?? this.env.workdir,
      env: { HOME: this.env.home },
      stdin: options.stdin,
      timeoutMs: options.timeoutMs ?? CONTROL_TIMEOUT_MS,
    });
    return result;
  }

  async create(sandboxId: string, sessionId: string): Promise<void> {
    const result = await this.sh(sandboxId, `mkdir -p ${shellQuote(sessionDir(sessionId))}`);
    if (result.exitCode !== 0) throw new BackendError("internal", `session create failed: ${result.stderr.trim()}`);
  }

  /** Kill every process in the sessions the launchers started (they are session leaders), then drop the directory. */
  async delete(sandboxId: string, sessionId: string): Promise<void> {
    const dir = sessionDir(sessionId);
    await this.sh(sandboxId, `${killSessionScript(dir)}; rm -rf ${shellQuote(dir)}`);
  }

  async get(sandboxId: string, sessionId: string): Promise<{ commands: LocalSessionCommand[] }> {
    const dir = sessionDir(sessionId);
    const result = await this.sh(sandboxId, `test -d ${shellQuote(dir)} && cd ${shellQuote(dir)} && for f in *.pid; do [ -e "$f" ] || continue; id=\${f%.pid}; if [ -s "$id.exit" ]; then printf '%s %s\\n' "$id" "$(cat "$id.exit")"; else printf '%s\\n' "$id"; fi; done`);
    if (result.timedOut) throw new BackendError("unavailable", "the sandbox did not answer in time");
    if (result.exitCode !== 0) throw new BackendError("not_found", `session ${sessionId} not found`);
    return {
      commands: result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [id, code] = line.split(" ");
          const exitCode = code === undefined ? undefined : Number.parseInt(code, 10);
          return { id: id ?? "", ...(exitCode !== undefined && !Number.isNaN(exitCode) ? { exitCode } : {}) };
        }),
    };
  }

  async list(sandboxId: string): Promise<string[]> {
    const result = await this.sh(sandboxId, `ls ${shellQuote(SESSION_ROOT)} 2>/dev/null || true`);
    return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  async command(sandboxId: string, sessionId: string, commandId: string): Promise<LocalSessionCommand> {
    const base = commandBase(sessionId, commandId);
    const result = await this.sh(sandboxId, `test -e ${shellQuote(`${base}.pid`)} || exit 3; cat ${shellQuote(`${base}.exit`)} 2>/dev/null || true`);
    // A read that did not complete says nothing about the command; "still running" must never be assumed.
    if (result.timedOut) throw new BackendError("unavailable", "the sandbox did not answer in time");
    if (result.exitCode === 3) throw new BackendError("not_found", `command ${commandId} not found in session ${sessionId}`);
    if (result.exitCode !== 0) throw new BackendError("internal", `command status read failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    const code = Number.parseInt(result.stdout.trim(), 10);
    return { id: commandId, ...(Number.isNaN(code) ? {} : { exitCode: code }) };
  }

  async execute(
    sandboxId: string,
    sessionId: string,
    command: string,
    runAsync: boolean,
    timeoutSeconds = SYNC_COMMAND_CAP_SECONDS,
  ): Promise<LocalSessionExecuteResult> {
    await this.create(sandboxId, sessionId);
    const commandId = crypto.randomUUID();
    if (!runAsync) {
      const result = await this.sh(sandboxId, command, { timeoutMs: timeoutSeconds * 1000 });
      return {
        cmdId: commandId,
        output: `${result.stdout}${result.stderr}`,
        exitCode: result.timedOut ? 124 : result.exitCode,
      };
    }
    const base = commandBase(sessionId, commandId);
    const encoder = new TextEncoder();
    const staged = await this.sh(
      sandboxId,
      `cat > ${shellQuote(`${base}.sh`)} && mkfifo ${shellQuote(`${base}.in`)}`,
      { stdin: encoder.encode(command) },
    );
    if (staged.exitCode !== 0) throw new BackendError("internal", `session command staging failed: ${staged.stderr.trim()}`);
    const launcher = await this.sh(sandboxId, `cat > ${shellQuote(`${base}.launch.sh`)}`, {
      stdin: encoder.encode(detachedLaunchScript(base, sessionId, commandId)),
    });
    if (launcher.exitCode !== 0) throw new BackendError("internal", `session launcher staging failed: ${launcher.stderr.trim()}`);
    // setsid + nohup + closed stdio: the process outlives this exec and the runner.
    const launched = await this.sh(
      sandboxId,
      `cd ${shellQuote(this.env.workdir)} || exit 1; nohup setsid sh ${shellQuote(`${base}.launch.sh`)} </dev/null >/dev/null 2>&1 &`,
    );
    if (launched.exitCode !== 0) throw new BackendError("internal", `session command launch failed: ${launched.stderr.trim()}`);
    return { cmdId: commandId, exitCode: 0 };
  }

  async logs(sandboxId: string, sessionId: string, commandId: string): Promise<{ output: string }> {
    const result = await this.sh(sandboxId, `cat ${shellQuote(`${commandBase(sessionId, commandId)}.log`)} 2>/dev/null || true`);
    if (result.timedOut) throw new BackendError("unavailable", "the sandbox did not answer in time");
    return { output: result.stdout };
  }

  /** Bytes for a detached command's stdin, through its FIFO. */
  async input(sandboxId: string, sessionId: string, commandId: string, data: string): Promise<void> {
    const fifo = `${commandBase(sessionId, commandId)}.in`;
    const result = await this.sh(sandboxId, `test -p ${shellQuote(fifo)} || exit 3; cat > ${shellQuote(fifo)}`, {
      stdin: new TextEncoder().encode(data),
    });
    if (result.exitCode === 3) throw new BackendError("not_found", `command ${commandId} has no stdin`);
    if (result.exitCode !== 0) throw new BackendError("internal", `session input failed: ${result.stderr.trim()}`);
  }

  /** Argv that follows a detached command's log until it exits (GNU tail). */
  followArgv(sessionId: string, commandId: string): string[] {
    const base = commandBase(sessionId, commandId);
    return [
      "sh",
      "-c",
      `pid=$(cat ${shellQuote(`${base}.pid`)} 2>/dev/null); if [ -z "$pid" ]; then exit 3; fi; ` +
        `tail -n +1 --pid="$pid" -f ${shellQuote(`${base}.log`)}`,
    ];
  }
}
