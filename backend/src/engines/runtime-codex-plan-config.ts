import { createHash } from "node:crypto";
import type { SandboxHandle, SandboxRuntimeLayout } from "../sandboxes/provider";
import { RUNTIME_ENVIRONMENT_HOME, restartRuntimeEnvironment } from "./runtime-environment";
import { invalidateRuntimeEnvironmentAccess } from "./runtime-environment-client";

export const CODEX_PLAN_LAUNCH_ARGS = "-c tools.update_plan.enabled=true";
const PENDING_PATH = `${RUNTIME_ENVIRONMENT_HOME}/caches/useagent-codex-provider-config-pending`;

export function codexProviderConfig(layout: SandboxRuntimeLayout) {
  const prefix = layout.runsAsRoot ? "/usr/local" : `${layout.home}/.local`;
  return {
    enabled: true,
    binaryPath: `${prefix}/bin/codex`,
    homePath: "~/.codex",
    shadowHomePath: "",
    launchArgs: CODEX_PLAN_LAUNCH_ARGS,
    customModels: [],
  };
}

export function codexProviderConfigurationRevision(layout: SandboxRuntimeLayout): string {
  return createHash("sha256")
    .update(JSON.stringify(codexProviderConfig(layout)))
    .digest("hex");
}

export function buildCodexProviderConfigUpdateScript(): string {
  return [
    'const fs=require("node:fs")',
    "const path=process.argv[1]",
    "const pendingPath=process.argv[2]",
    "const revision=process.argv[3]",
    'const patch=JSON.parse(Buffer.from(process.env.PATCH_B64,"base64").toString("utf8"))',
    "let current={}",
    'try{current=JSON.parse(fs.readFileSync(path,"utf8"))}catch{}',
    "const changed=JSON.stringify(current.providers?.[patch.provider])!==JSON.stringify(patch.config)",
    'if(changed){fs.mkdirSync(require("node:path").dirname(pendingPath),{recursive:true,mode:0o700});const pendingTmp=pendingPath+".tmp";fs.writeFileSync(pendingTmp,revision,{mode:0o600});fs.renameSync(pendingTmp,pendingPath);current.providers={...(current.providers??{}),[patch.provider]:patch.config};const tmp=path+".tmp";fs.writeFileSync(tmp,JSON.stringify(current));fs.chmodSync(tmp,0o600);fs.renameSync(tmp,path)}',
  ].join(";");
}

export function codexProviderConfigPendingPath(): string {
  return PENDING_PATH;
}

export function buildPendingCodexProviderConfigurationProbeCommand(revision: string): string {
  const script = [
    'const fs=require("node:fs")',
    "const path=process.argv[1]",
    "const expected=process.argv[2]",
    "let pending",
    'try{pending=fs.readFileSync(path,"utf8").trim()}catch(error){if(error?.code==="ENOENT"){console.log("absent");process.exit(0)}throw error}',
    "if(pending!==expected)process.exit(2)",
    'console.log("present:"+pending)',
  ].join(";");
  return `node -e ${JSON.stringify(script)} ${JSON.stringify(PENDING_PATH)} ${JSON.stringify(revision)}`;
}

export async function readPendingCodexProviderConfigurationRevision(
  sandbox: Pick<SandboxHandle, "process">,
  signal: AbortSignal,
  expectedRevision: string,
): Promise<string | null> {
  const result = await sandbox.process.executeCommand(
    buildPendingCodexProviderConfigurationProbeCommand(expectedRevision),
    undefined,
    undefined,
    5,
  );
  signal.throwIfAborted();
  if (!result || (result.exitCode ?? 1) !== 0) {
    throw new Error("Codex provider configuration marker read failed");
  }
  const response = result.result?.trim();
  if (response === "absent") return null;
  if (response === `present:${expectedRevision}`) return expectedRevision;
  throw new Error("Codex provider configuration marker response is invalid");
}

export function buildAcknowledgeCodexProviderConfigurationCommand(revision: string): string {
  if (!/^[0-9a-f]{64}$/.test(revision)) {
    throw new Error("Codex provider configuration revision is invalid");
  }
  const script = [
    'const fs=require("node:fs")',
    "const path=process.argv[1]",
    "const revision=process.argv[2]",
    "let pending",
    'try{pending=fs.readFileSync(path,"utf8").trim()}catch(error){if(error?.code==="ENOENT")process.exit(0);throw error}',
    "if(pending===revision)fs.unlinkSync(path)",
  ].join(";");
  return `node -e ${JSON.stringify(script)} ${JSON.stringify(PENDING_PATH)} ${JSON.stringify(revision)}`;
}

interface ApplyCodexProviderConfigurationDependencies {
  readonly restart: typeof restartRuntimeEnvironment;
  readonly invalidateAccess: typeof invalidateRuntimeEnvironmentAccess;
}

export async function applyPendingCodexProviderConfiguration(input: {
  readonly sandbox: SandboxHandle;
  readonly signal: AbortSignal;
  readonly revision: string | null;
  readonly timing?: Parameters<typeof restartRuntimeEnvironment>[2];
  readonly dependencies?: ApplyCodexProviderConfigurationDependencies;
}): Promise<boolean> {
  if (!input.revision) return false;
  const dependencies = input.dependencies ?? {
    restart: restartRuntimeEnvironment,
    invalidateAccess: invalidateRuntimeEnvironmentAccess,
  };
  input.signal.throwIfAborted();
  await dependencies.restart(input.sandbox, input.signal, input.timing);
  dependencies.invalidateAccess(input.sandbox);
  input.signal.throwIfAborted();
  const acknowledged = await input.sandbox.process.executeCommand(
    buildAcknowledgeCodexProviderConfigurationCommand(input.revision),
    undefined,
    undefined,
    5,
  );
  if ((acknowledged.exitCode ?? 1) !== 0) {
    throw new Error("Codex provider configuration acknowledgement failed");
  }
  return true;
}
