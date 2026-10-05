import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

export type RunnerStatus = {
  state: "starting" | "pulling" | "online" | "offline" | "error";
  detail: string;
  progress: number;
};

export type RunnerOptions = {
  binary: string;
  plane: string;
  backend?: "docker" | "apple" | "auto";
  shareLogins?: readonly ("codex" | "claude" | "opencode")[];
  onTokenRejected?: () => void;
};

type RunnerChild = ChildProcessByStdio<null, Readable, Readable>;
type SpawnRunner = typeof spawn;

const MAX_STATUS_LINE = 64 * 1024;
const MAX_RESTART_DELAY = 30_000;
const STABLE_UPTIME = 30_000;
const allowedEnvironment = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
  "DOCKER_DEFAULT_PLATFORM",
  "CONTAINER_HOST",
  "CONTAINER_CONNECTION",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

const terminalErrors: Partial<Record<number, string>> = {
  1: "The runner command is invalid. Reinstall the desktop app.",
  2: "The runner token was rejected. Connect this machine again.",
  3: "No supported container backend is available.",
  4: "The control plane must be updated before this runner can connect.",
  5: "The runner must be updated before it can connect to this control plane.",
};

function runnerEnvironment(token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { USEAGENT_RUNNER_TOKEN: token };
  for (const [name, value] of Object.entries(process.env)) {
    const canonicalName = name.toUpperCase();
    if (
      value !== undefined &&
      (allowedEnvironment.has(canonicalName) || canonicalName.startsWith("LC_") || canonicalName.startsWith("XDG_"))
    ) {
      env[name] = value;
    }
  }
  return env;
}

export function createRunnerController(options: RunnerOptions, spawnRunner: SpawnRunner = spawn) {
  let status: RunnerStatus = { state: "offline", detail: "Runner is stopped.", progress: 0 };
  let child: RunnerChild | undefined;
  let token: string | undefined;
  let shouldRun = false;
  let restartAttempt = 0;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let operations = Promise.resolve();

  const args = ["--plane", options.plane];
  if (options.backend) args.push("--backend", options.backend);
  const shareLogins = (["codex", "claude", "opencode"] as const).filter((login) => options.shareLogins?.includes(login));
  if (shareLogins.length > 0) args.push("--share-logins", shareLogins.join(","));

  function setProtocolError(): void {
    status = { state: "error", detail: "Runner sent an invalid status update.", progress: 0 };
  }

  function applyStatus(line: string, launchedToken: string): void {
    try {
      const next = JSON.parse(line) as Partial<RunnerStatus>;
      if (
        !["starting", "pulling", "online", "offline", "error"].includes(next.state ?? "") ||
        typeof next.detail !== "string" ||
        next.detail.includes(launchedToken) ||
        typeof next.progress !== "number" ||
        !Number.isFinite(next.progress) ||
        next.progress < 0 ||
        next.progress > 1
      ) {
        return setProtocolError();
      }
      status = { state: next.state as RunnerStatus["state"], detail: next.detail, progress: next.progress };
    } catch {
      setProtocolError();
    }
  }

  function readStatus(stream: Readable, launchedToken: string, isCurrent: () => boolean): void {
    let pending = "";
    let discarding = false;
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      if (!isCurrent()) return;
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf("\n", offset);
        const end = newline === -1 ? chunk.length : newline;

        if (!discarding) {
          const part = chunk.slice(offset, end);
          if (pending.length + part.length > MAX_STATUS_LINE) {
            pending = "";
            discarding = true;
            setProtocolError();
          } else {
            pending += part;
          }
        }

        if (newline === -1) return;
        if (!discarding && pending.length > 0) {
          applyStatus(pending.endsWith("\r") ? pending.slice(0, -1) : pending, launchedToken);
        }
        pending = "";
        discarding = false;
        offset = newline + 1;
      }
    });
  }

  function scheduleRestart(): void {
    if (!shouldRun || !token || restartTimer) return;
    const delay = Math.min(1_000 * 2 ** restartAttempt++, MAX_RESTART_DELAY);
    status = { state: "offline", detail: `Runner stopped unexpectedly. Restarting in ${delay / 1_000}s.`, progress: 0 };
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      void enqueue(async () => {
        if (shouldRun && token && !child) launch();
      });
    }, delay);
  }

  function launch(): void {
    if (!token) return;
    const launchedToken = token;
    status = { state: "starting", detail: "Starting runner.", progress: 0 };

    let spawned: RunnerChild;
    try {
      spawned = spawnRunner(options.binary, args, {
        env: runnerEnvironment(launchedToken),
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      status = { state: "error", detail: "Runner could not be started.", progress: 0 };
      return scheduleRestart();
    }

    child = spawned;
    readStatus(spawned.stdout, launchedToken, () => child === spawned);
    spawned.stderr.resume();
    const stableTimer = setTimeout(() => {
      if (child === spawned) restartAttempt = 0;
    }, STABLE_UPTIME);

    let settled = false;
    const fail = (detail: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(stableTimer);
      if (child !== spawned) return;
      child = undefined;
      shouldRun = false;
      token = undefined;
      status = { state: "error", detail, progress: 0 };
    };
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(stableTimer);
      if (child !== spawned) return;
      child = undefined;

      if (code === 0) {
        shouldRun = false;
        token = undefined;
        status = { state: "offline", detail: "Runner is stopped.", progress: 0 };
        return;
      }

      const detail = code === null ? undefined : terminalErrors[code];
      if (detail) {
        shouldRun = false;
        token = undefined;
        status = { state: "error", detail, progress: 0 };
        if (code === 2) options.onTokenRejected?.();
        return;
      }

      scheduleRestart();
    };

    spawned.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") fail("Runner binary is missing. Reinstall the desktop app.");
      else finish(null);
    });
    spawned.once("close", (code) => finish(code));
  }

  function cancelRestart(): void {
    if (!restartTimer) return;
    clearTimeout(restartTimer);
    restartTimer = undefined;
  }

  function terminate(spawned: RunnerChild): Promise<void> {
    if (spawned.exitCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timeout = setTimeout(() => {
        if (!spawned.kill("SIGKILL")) return reject(new Error("Runner did not stop."));
        timeout = setTimeout(() => reject(new Error("Runner did not stop.")), 1_000);
      }, 5_000);
      spawned.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      spawned.kill();
    });
  }

  function enqueue(operation: () => Promise<void>): Promise<void> {
    const next = operations.then(operation, operation);
    operations = next.catch(() => undefined);
    return next;
  }

  async function replace(nextToken: string): Promise<void> {
    if (!nextToken || nextToken.length > 8_192) throw new Error("Invalid runner token.");
    shouldRun = true;
    token = nextToken;
    restartAttempt = 0;
    cancelRestart();
    const previous = child;
    child = undefined;
    if (previous) await terminate(previous);
    if (shouldRun && token === nextToken) launch();
  }

  return {
    start(nextToken: string): Promise<void> {
      return enqueue(() => replace(nextToken));
    },
    restart(nextToken: string): Promise<void> {
      return enqueue(() => replace(nextToken));
    },
    stop(): Promise<void> {
      return enqueue(async () => {
        shouldRun = false;
        token = undefined;
        cancelRestart();
        const previous = child;
        child = undefined;
        if (previous) await terminate(previous);
        status = { state: "offline", detail: "Runner is stopped.", progress: 0 };
      });
    },
    getStatus(): RunnerStatus {
      return { ...status };
    },
  };
}
