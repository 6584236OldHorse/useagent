// Command line of the runner binary. The token never travels in argv.

import { homedir } from "node:os";
import { join } from "node:path";
import type { BackendChoice } from "./backends/detect";

export const RUNNER_VERSION = "0.1.0";

/** Exit codes the desktop shell relies on. */
export const EXIT = {
  ok: 0,
  usage: 1,
  tokenRejected: 2,
  noBackend: 3,
  planeTooOld: 4,
  runnerTooOld: 5,
} as const;

export interface RunCommand {
  readonly command: "run";
  readonly planeUrl: string;
  readonly backend: BackendChoice;
  readonly shareLogins: readonly string[];
  readonly maxSandboxes: number;
  readonly dataDir: string;
}

export interface UninstallCommand {
  readonly command: "uninstall";
  readonly backend: BackendChoice;
  readonly dataDir: string;
}

export type Command = RunCommand | UninstallCommand | { readonly command: "version" } | { readonly command: "help" };

export function defaultDataDir(home = homedir(), platform = process.platform): string {
  if (platform === "darwin") return join(home, "Library", "Application Support", "useagent-runner");
  if (platform === "win32") return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "useagent-runner");
  return join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "useagent-runner");
}

export const USAGE = `useagent-runner --plane <url> [--backend auto|docker|apple] [--share-logins codex,claude,opencode] [--max-sandboxes N] [--data-dir <path>]
useagent-runner uninstall [--backend auto|docker|apple] [--data-dir <path>]
useagent-runner --version

The runner token comes from the USEAGENT_RUNNER_TOKEN environment variable.
Exit codes: 0 clean stop, 1 usage, 2 token rejected, 3 no container backend, 4 control plane too old, 5 runner too old.`;

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

export function parseArgs(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = process.env): Command {
  let planeUrl = env.USEAGENT_PLANE_URL ?? "";
  let backend: BackendChoice = "auto";
  let shareLogins: string[] = [];
  let maxSandboxes = 4;
  let dataDir = defaultDataDir();
  let command: "run" | "uninstall" = "run";
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case "--version":
      case "-v":
        return { command: "version" };
      case "--help":
      case "-h":
        return { command: "help" };
      case "uninstall":
        command = "uninstall";
        break;
      case "--plane":
        planeUrl = takeValue(argv, i, arg);
        i += 1;
        break;
      case "--backend": {
        const value = takeValue(argv, i, arg);
        if (value !== "auto" && value !== "docker" && value !== "apple") throw new Error("--backend must be auto, docker or apple");
        backend = value;
        i += 1;
        break;
      }
      case "--share-logins":
        shareLogins = takeValue(argv, i, arg).split(",").map((s) => s.trim()).filter(Boolean);
        i += 1;
        break;
      case "--max-sandboxes": {
        const value = Number.parseInt(takeValue(argv, i, arg), 10);
        if (!Number.isInteger(value) || value < 1) throw new Error("--max-sandboxes must be a positive integer");
        maxSandboxes = value;
        i += 1;
        break;
      }
      case "--data-dir":
        dataDir = takeValue(argv, i, arg);
        i += 1;
        break;
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }
  if (command === "uninstall") return { command, backend, dataDir };
  if (!planeUrl) throw new Error("--plane <url> is required");
  let parsed: URL;
  try {
    parsed = new URL(planeUrl);
  } catch {
    throw new Error(`--plane is not a URL: ${planeUrl}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("--plane must be an http(s) URL");
  return { command: "run", planeUrl: parsed.origin, backend, shareLogins, maxSandboxes, dataDir };
}

/** `uart_<runnerId>.<secret>`: the runner learns its id from the token the plane issued. */
export function runnerIdFromToken(token: string): string | null {
  const match = /^uart_([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/.exec(token.trim());
  return match?.[1] ?? null;
}
