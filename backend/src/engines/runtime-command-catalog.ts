import { normalizeOpencodeCommands, type CanonicalCommand, type HarnessSession } from "@useagent/agent-harness/canonical";
import { recordSessionCommandCatalog } from "../runs/session-command-catalog";
import type { SandboxHandle } from "../sandboxes/provider";
import { errorMessage } from "../util/error-message";
import { RUNTIME_ENVIRONMENT_HOME } from "./runtime-environment";
import { awaitRuntimeOperation } from "./runtime-operation";
import { PROVIDER_INSTANCE, type RuntimeEngineId } from "./runtime-orchestration";
import type { EngineRunContext } from "./types";

// ---------------------------------------------------------------------------
// The resident runtime keeps one provider status snapshot per configured
// instance at `<runtime home>/caches/<instanceId>.json` and rewrites it whenever
// the snapshot changes. Its `slashCommands` is the command list that provider
// advertises for the session: Claude's initialization commands plus compact,
// Codex's compact and feedback, OpenCode's compact. The plane reads it through
// the same shell probe path the readiness checks use and records it in the
// session command catalog table (runs/session-command-catalog.ts), which the
// reply composer's typed commands and Compact are authorized against.
// ---------------------------------------------------------------------------

const PROBE_TIMEOUT_SECONDS = 5;
// The sandbox transport is asked to give up after PROBE_TIMEOUT_SECONDS, but a
// transport whose response stalls never settles on its own; the plane keeps its
// own deadline so a stalled probe can never hold the turn open.
const PROBE_DEADLINE_MS = 10_000;

export function runtimeCommandCatalogCachePath(engine: RuntimeEngineId): string {
  return `${RUNTIME_ENVIRONMENT_HOME}/caches/${PROVIDER_INSTANCE[engine]}.json`;
}

/** Prints the snapshot's identity and command fields only; models, usage and
 *  auth details stay in the sandbox. Exits non-zero when the cache is absent or
 *  not JSON, which the caller treats as "no catalog", never as an empty one. */
export function buildRuntimeCommandCatalogProbeCommand(engine: RuntimeEngineId): string {
  const script = [
    'const v=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))',
    "process.stdout.write(JSON.stringify({instanceId:v.instanceId,driver:v.driver,checkedAt:v.checkedAt,slashCommands:v.slashCommands}))",
  ].join(";");
  return [
    "set -eu",
    `node -e ${JSON.stringify(script)} ${JSON.stringify(runtimeCommandCatalogCachePath(engine))}`,
  ].join("\n");
}

export interface RuntimeCommandCatalogSnapshot {
  readonly commands: readonly CanonicalCommand[];
  readonly checkedAt?: string;
}

/** The catalog in a probe's output, or null when the output is not this
 *  engine's snapshot (the runtime itself trusts a cache only when its identity
 *  matches, never the file name). Commands go through the one normalization the
 *  ACP and OpenCode catalogs use, so `input: { hint }` becomes the wire `input`. */
export function parseRuntimeCommandCatalog(
  output: string,
  engine: RuntimeEngineId,
): RuntimeCommandCatalogSnapshot | null {
  let raw: unknown;
  try {
    raw = JSON.parse(output);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as { instanceId?: unknown; slashCommands?: unknown; checkedAt?: unknown };
  if (rec.instanceId !== PROVIDER_INSTANCE[engine] || !Array.isArray(rec.slashCommands)) return null;
  return {
    commands: normalizeOpencodeCommands(rec.slashCommands),
    ...(typeof rec.checkedAt === "string" ? { checkedAt: rec.checkedAt } : {}),
  };
}

/** Read the session's command catalog from the runtime and record it. Best
 *  effort by construction: nothing here can fail a turn, and nothing here can
 *  hold one open past its bounds. The probe runs under the run's signal and the
 *  plane's own deadline; the write is one statement bounded by the database's
 *  statement_timeout and is skipped once the run is stopped. A probe that finds
 *  no readable snapshot, a deadline, or a write that did not land is logged and
 *  records nothing: a command intent then fails closed, as it does today, and
 *  the next read records again. The provider is the engine, which is what the
 *  reply route authorizes against and what the pre-session picker is keyed by. */
export async function recordRuntimeCommandCatalog(input: {
  readonly ctx: Pick<EngineRunContext, "runId" | "threadId" | "signal">;
  readonly sandbox: { readonly process: Pick<SandboxHandle["process"], "executeCommand"> };
  readonly engine: RuntimeEngineId;
  readonly session: Pick<HarnessSession, "nativeSessionId">;
  readonly deadlineMs?: number;
  readonly writeTimeoutMs?: number;
  readonly record?: typeof recordSessionCommandCatalog;
}): Promise<void> {
  const { ctx, engine } = input;
  if (ctx.signal.aborted) return;
  try {
    const deadline = AbortSignal.any([ctx.signal, AbortSignal.timeout(input.deadlineMs ?? PROBE_DEADLINE_MS)]);
    const probe = await awaitRuntimeOperation(
      input.sandbox.process.executeCommand(
        buildRuntimeCommandCatalogProbeCommand(engine),
        undefined,
        undefined,
        PROBE_TIMEOUT_SECONDS,
      ),
      deadline,
      async () => {},
    );
    const snapshot = probe.exitCode === 0 ? parseRuntimeCommandCatalog(probe.result ?? "", engine) : null;
    if (!snapshot) {
      console.warn("[runtime-command-catalog] the provider status cache has no command catalog", { runId: ctx.runId, engine });
      return;
    }
    // A Stop after the probe records nothing; a Stop during the write cannot cut
    // the statement short of its timeout, and does not need to: the write is not
    // awaited by finalization and a row that lands is the catalog the runtime advertised.
    if (ctx.signal.aborted) return;
    await (input.record ?? recordSessionCommandCatalog)({
      threadId: ctx.threadId ?? ctx.runId,
      provider: engine,
      nativeSessionId: input.session.nativeSessionId,
      commands: snapshot.commands,
    }, input.writeTimeoutMs);
  } catch (error) {
    if (ctx.signal.aborted) return;
    console.error("[runtime-command-catalog] the command catalog was not recorded", {
      runId: ctx.runId,
      engine,
      error: errorMessage(error),
    });
  }
}
