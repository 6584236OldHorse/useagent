// A retained Codex session keeps the config.toml it started with: the runtime
// never asks Codex to reload it, and the tool gateway's bearer lives there. So
// each thread is stamped with the config its session runs on, and a turn that
// finds the file changed detaches the idle session first (reloadRetainedSession).
import { createHash } from "node:crypto";
import type { SandboxHandle } from "../sandboxes/provider";
import { RUNTIME_ENVIRONMENT_HOME } from "./runtime-environment";

const CODEX_CONFIG_PATH = "$HOME/.codex/config.toml";
const STAMP_DIR = `${RUNTIME_ENVIRONMENT_HOME}/caches/codex-config-sessions`;

const stampPath = (threadId: string) => `${STAMP_DIR}/${createHash("sha256").update(threadId).digest("hex")}`;

/**
 * Prints `same` when the thread's stamp matches the config now, else
 * `changed:<revision>`. A fresh thread's first session reads the config now,
 * so it is stamped at once. `stamp` writes the given revision.
 */
export function buildCodexConfigStampCommand(threadId: string, mode: "check" | "fresh" | { readonly stamp: string }): string {
  const script = [
    'const fs=require("node:fs")',
    'const crypto=require("node:crypto")',
    "const [config,stamp,mode]=process.argv.slice(1)",
    'const write=(revision)=>{fs.mkdirSync(require("node:path").dirname(stamp),{recursive:true,mode:0o700});fs.writeFileSync(stamp+".tmp",revision,{mode:0o600});fs.renameSync(stamp+".tmp",stamp)}',
    'if(mode.startsWith("stamp:")){write(mode.slice(6));process.exit(0)}',
    'let revision="absent"',
    'try{revision=crypto.createHash("sha256").update(fs.readFileSync(config)).digest("hex")}catch(error){if(error?.code!=="ENOENT")throw error}',
    "let stamped=null",
    'try{stamped=fs.readFileSync(stamp,"utf8").trim()}catch(error){if(error?.code!=="ENOENT")throw error}',
    'if(stamped===revision){console.log("same");process.exit(0)}',
    'if(mode==="fresh"){write(revision);console.log("same");process.exit(0)}',
    'console.log("changed:"+revision)',
  ].join(";");
  const argument = typeof mode === "string" ? mode : `stamp:${mode.stamp}`;
  return `node -e ${JSON.stringify(script)} ${JSON.stringify(CODEX_CONFIG_PATH)} ${JSON.stringify(stampPath(threadId))} ${JSON.stringify(argument)}`;
}

/** The config revision a thread's retained session has not started with, or null when it has. */
export async function readCodexConfigChange(
  sandbox: Pick<SandboxHandle, "process">,
  threadId: string,
  threadExists: boolean,
): Promise<string | null> {
  const result = await sandbox.process.executeCommand(
    buildCodexConfigStampCommand(threadId, threadExists ? "check" : "fresh"), undefined, undefined, 10,
  );
  const response = result?.result?.trim();
  if ((result?.exitCode ?? 1) !== 0 || !response) throw new Error("Codex config stamp read failed");
  if (response === "same") return null;
  const revision = /^changed:([0-9a-f]{64}|absent)$/u.exec(response)?.[1];
  if (!revision) throw new Error("Codex config stamp response is invalid");
  return revision;
}

/** Stamps the thread once its retained session left, so its next session runs on `revision`. */
export async function stampCodexConfig(sandbox: Pick<SandboxHandle, "process">, threadId: string, revision: string): Promise<void> {
  const result = await sandbox.process.executeCommand(
    buildCodexConfigStampCommand(threadId, { stamp: revision }), undefined, undefined, 10,
  );
  if ((result?.exitCode ?? 1) !== 0) throw new Error("Codex config stamp write failed");
}
