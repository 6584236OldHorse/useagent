// Logins already on this machine that a sandbox may borrow: Codex and OpenCode
// keep a file, Claude keeps a keychain item on macOS. Each shared login is
// staged as one directory the container mounts at /run/useagent/logins/<name>,
// and the sandbox env names the file. Codex and OpenCode files are hard links,
// so a token the CLI refreshes in place flows back to the host; a CLI that
// replaces the file breaks the link, and the runner copies the staged file
// back when the sandbox stops. The Claude credential is written back to the
// keychain the same way.

import { chmod, copyFile, link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ContainerMount } from "./backends/types";

export const LOGIN_NAMES = ["codex", "claude", "opencode"] as const;
export type LoginName = (typeof LOGIN_NAMES)[number];
export const LOGIN_MOUNT_ROOT = "/run/useagent/logins";

export interface LoginSource {
  readonly name: LoginName;
  readonly file: string;
  /** Where the credential lives on the host, or null when it is in the keychain. */
  readonly hostPath: string | null;
}

export function loginSources(home = homedir(), platform = process.platform): LoginSource[] {
  return [
    { name: "codex", file: "auth.json", hostPath: join(home, ".codex", "auth.json") },
    { name: "opencode", file: "auth.json", hostPath: join(home, ".local", "share", "opencode", "auth.json") },
    {
      name: "claude",
      file: ".credentials.json",
      hostPath: platform === "darwin" ? null : join(home, ".claude", ".credentials.json"),
    },
  ];
}

export interface Keychain {
  read(service: string): Promise<string | null>;
  write(service: string, secret: string): Promise<void>;
}

export const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** macOS keychain through the security tool; secrets travel through stdio only. */
export const macKeychain: Keychain = {
  async read(service) {
    const proc = Bun.spawn(["security", "find-generic-password", "-s", service, "-w"], { stdout: "pipe", stderr: "ignore" });
    const text = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? text.replace(/\n$/, "") : null;
  },
  async write(service, secret) {
    const account = process.env.USER ?? "";
    const proc = Bun.spawn(["security", "add-generic-password", "-U", "-s", service, "-a", account, "-w", secret], { stdout: "ignore", stderr: "ignore" });
    await proc.exited;
  },
};

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

export class LoginStore {
  constructor(
    private readonly stagingRoot: string,
    private readonly sources: readonly LoginSource[] = loginSources(),
    private readonly keychain: Keychain | null = process.platform === "darwin" ? macKeychain : null,
  ) {}

  /** Logins present on this machine right now. */
  async available(): Promise<LoginName[]> {
    const found: LoginName[] = [];
    for (const source of this.sources) {
      if (source.hostPath ? await exists(source.hostPath) : await this.keychain?.read(CLAUDE_KEYCHAIN_SERVICE)) found.push(source.name);
    }
    return found;
  }

  /** Mounts and env for the requested logins that exist; missing ones are skipped. */
  async mounts(requested: readonly string[]): Promise<{ mounts: ContainerMount[]; env: Record<string, string> }> {
    const mounts: ContainerMount[] = [];
    const env: Record<string, string> = {};
    for (const source of this.sources) {
      if (!requested.includes(source.name)) continue;
      const dir = join(this.stagingRoot, source.name);
      const staged = join(dir, source.file);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true, mode: 0o700 });
      if (source.hostPath) {
        if (!(await exists(source.hostPath))) continue;
        try {
          await link(source.hostPath, staged);
        } catch {
          await copyFile(source.hostPath, staged);
        }
      } else {
        const secret = await this.keychain?.read(CLAUDE_KEYCHAIN_SERVICE);
        if (!secret) continue;
        await writeFile(staged, secret, { mode: 0o600 });
      }
      await chmod(staged, 0o600);
      mounts.push({ hostPath: dir, containerPath: `${LOGIN_MOUNT_ROOT}/${source.name}`, readonly: false });
      env[`USEAGENT_LOGIN_${source.name.toUpperCase()}`] = `${LOGIN_MOUNT_ROOT}/${source.name}/${source.file}`;
    }
    return { mounts, env };
  }

  /** Carry refreshed credentials back to where the host keeps them. */
  async syncBack(): Promise<LoginName[]> {
    const synced: LoginName[] = [];
    for (const source of this.sources) {
      const staged = join(this.stagingRoot, source.name, source.file);
      if (!(await exists(staged))) continue;
      const bytes = await readFile(staged);
      if (source.hostPath) {
        const current = await readFile(source.hostPath).catch(() => null);
        if (current && current.equals(bytes)) continue;
        await writeFile(source.hostPath, bytes, { mode: 0o600 });
        synced.push(source.name);
      } else if (this.keychain) {
        const current = await this.keychain.read(CLAUDE_KEYCHAIN_SERVICE);
        const next = bytes.toString("utf8");
        if (current === next) continue;
        await this.keychain.write(CLAUDE_KEYCHAIN_SERVICE, next);
        synced.push(source.name);
      }
    }
    return synced;
  }
}
