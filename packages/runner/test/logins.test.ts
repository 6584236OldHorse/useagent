import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_KEYCHAIN_SERVICE, type Keychain, LOGIN_MOUNT_ROOT, LoginStore, loginSources } from "../src/logins";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "runner-logins-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fakeKeychain(initial: string | null): Keychain & { stored: string | null } {
  const store = {
    stored: initial,
    async read(service: string) {
      return service === CLAUDE_KEYCHAIN_SERVICE ? store.stored : null;
    },
    async write(_service: string, secret: string) {
      store.stored = secret;
    },
  };
  return store;
}

describe("login sources", () => {
  test("name the host files, and the keychain on macOS", () => {
    const mac = loginSources("/Users/me", "darwin");
    expect(mac.find((s) => s.name === "codex")?.hostPath).toBe("/Users/me/.codex/auth.json");
    expect(mac.find((s) => s.name === "opencode")?.hostPath).toBe("/Users/me/.local/share/opencode/auth.json");
    expect(mac.find((s) => s.name === "claude")?.hostPath).toBeNull();
    expect(loginSources("/home/me", "linux").find((s) => s.name === "claude")?.hostPath).toBe("/home/me/.claude/.credentials.json");
  });
});

describe("login store", () => {
  test("reports only the logins that exist", async () => {
    const home = join(root, "home");
    await writeFile(join(root, "codex-auth.json"), "{}", { mode: 0o600 }).catch(() => {});
    const sources = [
      { name: "codex" as const, file: "auth.json", hostPath: join(root, "codex-auth.json") },
      { name: "opencode" as const, file: "auth.json", hostPath: join(home, "missing.json") },
      { name: "claude" as const, file: ".credentials.json", hostPath: null },
    ];
    const store = new LoginStore(join(root, "staging"), sources, fakeKeychain(null));
    expect(await store.available()).toEqual(["codex"]);
    const withClaude = new LoginStore(join(root, "staging"), sources, fakeKeychain('{"claudeAiOauth":{}}'));
    expect(await withClaude.available()).toEqual(["codex", "claude"]);
  });

  test("stages requested logins as mounts with env naming the file", async () => {
    const codexPath = join(root, "auth.json");
    await writeFile(codexPath, '{"token":"a"}', { mode: 0o600 });
    const keychain = fakeKeychain('{"claudeAiOauth":{"accessToken":"x"}}');
    const store = new LoginStore(join(root, "staging"), [
      { name: "codex", file: "auth.json", hostPath: codexPath },
      { name: "claude", file: ".credentials.json", hostPath: null },
      { name: "opencode", file: "auth.json", hostPath: join(root, "absent.json") },
    ], keychain);
    const { mounts, env } = await store.mounts(["codex", "claude", "opencode"]);
    expect(mounts.map((m) => m.containerPath)).toEqual([`${LOGIN_MOUNT_ROOT}/codex`, `${LOGIN_MOUNT_ROOT}/claude`]);
    expect(env).toEqual({
      USEAGENT_LOGIN_CODEX: `${LOGIN_MOUNT_ROOT}/codex/auth.json`,
      USEAGENT_LOGIN_CLAUDE: `${LOGIN_MOUNT_ROOT}/claude/.credentials.json`,
    });
    const stagedCodex = join(root, "staging", "codex", "auth.json");
    const stagedClaude = join(root, "staging", "claude", ".credentials.json");
    expect((await stat(stagedCodex)).mode & 0o777).toBe(0o600);
    expect(await readFile(stagedClaude, "utf8")).toBe('{"claudeAiOauth":{"accessToken":"x"}}');
    // A hard link: writes through the staged path land in the host file.
    await writeFile(stagedCodex, '{"token":"refreshed"}');
    expect(await readFile(codexPath, "utf8")).toBe('{"token":"refreshed"}');
  });

  test("a login that was not requested is not staged", async () => {
    const codexPath = join(root, "auth.json");
    await writeFile(codexPath, "{}", { mode: 0o600 });
    const store = new LoginStore(join(root, "staging"), [{ name: "codex", file: "auth.json", hostPath: codexPath }], null);
    const { mounts, env } = await store.mounts([]);
    expect(mounts).toEqual([]);
    expect(env).toEqual({});
  });

  test("sync back writes a changed Claude credential to the keychain and a replaced file to the host", async () => {
    const codexPath = join(root, "auth.json");
    await writeFile(codexPath, '{"token":"a"}', { mode: 0o600 });
    const keychain = fakeKeychain('{"v":1}');
    const store = new LoginStore(join(root, "staging"), [
      { name: "codex", file: "auth.json", hostPath: codexPath },
      { name: "claude", file: ".credentials.json", hostPath: null },
    ], keychain);
    await store.mounts(["codex", "claude"]);
    // The CLI inside the container replaced the file (new inode) and refreshed the Claude token.
    await rm(join(root, "staging", "codex", "auth.json"));
    await writeFile(join(root, "staging", "codex", "auth.json"), '{"token":"b"}');
    await writeFile(join(root, "staging", "claude", ".credentials.json"), '{"v":2}');
    expect(await store.syncBack()).toEqual(["codex", "claude"]);
    expect(await readFile(codexPath, "utf8")).toBe('{"token":"b"}');
    expect(keychain.stored).toBe('{"v":2}');
    expect(await store.syncBack()).toEqual([]);
  });
});
