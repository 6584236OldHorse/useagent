import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateDockerConfig } from "../src/backends/docker";

const LOGIN = { registry: "app.example", username: "runner", password: "uart_r1.secret" };
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function machineConfig(withContext: boolean): Promise<string> {
  const machine = await mkdtemp(join(tmpdir(), "useagent-machine-"));
  dirs.push(machine);
  if (withContext) {
    await writeFile(join(machine, "config.json"), JSON.stringify({ currentContext: "remote-tls", credsStore: "desktop", auths: { "ghcr.io": { auth: "bWU6bWluZQ==" } } }));
    await mkdir(join(machine, "contexts", "tls", "abc", "docker"), { recursive: true });
    await writeFile(join(machine, "contexts", "tls", "abc", "docker", "ca.pem"), "ca");
  }
  return machine;
}

test("the private config keeps the machine's current context and can read its TLS material", async () => {
  const machine = await machineConfig(true);
  const dir = await privateDockerConfig(LOGIN, machine);
  dirs.push(dir);
  const config = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
  expect(config).toEqual({ currentContext: "remote-tls", auths: { "app.example": { auth: btoa("runner:uart_r1.secret") } } });
  expect(await readFile(join(dir, "contexts", "tls", "abc", "docker", "ca.pem"), "utf8")).toBe("ca");
});

test("removing the private config leaves the machine's context store in place", async () => {
  const machine = await machineConfig(true);
  const dir = await privateDockerConfig(LOGIN, machine);
  await rm(dir, { recursive: true, force: true });
  expect((await stat(join(machine, "contexts", "tls", "abc", "docker", "ca.pem"))).isFile()).toBe(true);
});

test("a machine without a docker config gets a login-only config", async () => {
  const machine = await machineConfig(false);
  const dir = await privateDockerConfig(LOGIN, machine);
  dirs.push(dir);
  expect(JSON.parse(await readFile(join(dir, "config.json"), "utf8"))).toEqual({ auths: { "app.example": { auth: btoa("runner:uart_r1.secret") } } });
});
