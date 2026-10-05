import { PERMISSION_MODES, type PermissionMode } from "@useagent/agent-client/wire";
import { canonicalEngine } from "./engine-alias";
import type { RuntimeApprovalDecision, RuntimeApprovalRequest } from "./runtime-approval";
import { operatorEnv } from "./runtime-env";
import type { RuntimeMode } from "./runtime-orchestration";

// ---------------------------------------------------------------------------
// The per-run permission policy (see PERMISSION_MODES in the wire contract):
// what a run's resident runtime may do without asking. Guard, Guard with edits
// auto-applied, Auto and Full access are the runtime's own modes and the
// runtime enforces them. Read only rides the runtime's "approval-required"
// mode and the control plane refuses every command and file change the
// runtime asks about, so the sandbox never writes. The mode is chosen in the
// composer, stored on the run, handed to the runtime by the adapter, and
// checked again by the approval reply route.
// ---------------------------------------------------------------------------

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);
}

/** The operator's default posture for runs created without a choice (API
 *  callers, Slack, bots, schedules): RUNTIME_MODE (legacy T3_RUNTIME_MODE),
 *  the runtime's own autonomous default when unset. */
export function configuredRuntimeMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeMode {
  const mode = operatorEnv(env, "RUNTIME_MODE", "T3_RUNTIME_MODE")?.trim() || "full-access";
  if (
    mode !== "approval-required" &&
    mode !== "auto-accept-edits" &&
    mode !== "auto" &&
    mode !== "full-access"
  ) {
    throw new Error(
      "RUNTIME_MODE (legacy T3_RUNTIME_MODE) must be approval-required, auto-accept-edits, auto, or full-access",
    );
  }
  return mode;
}

/** The mode the resident runtime is started and steered with. Read only is
 *  Guard at the runtime; the refusal itself lives in the control plane. */
export function runtimeModeFor(mode: PermissionMode): RuntimeMode {
  return mode === "read-only" ? "approval-required" : mode;
}

/** Pi's bridge advertises no approval mediation (its tools run natively, see
 *  pi-provider-driver.ts), so a mode below full access cannot be honoured
 *  there. Every other engine either runs on the resident runtime, which asks
 *  before acting, or never touches a sandbox. */
export function permissionModeSupported(engine: string): boolean {
  return canonicalEngine(engine) !== "pi";
}

/** For a read-only run: what the runtime asked to do and must be refused, or
 *  null when the request may proceed (reading a file). Unknown request kinds
 *  are refused too; a read-only run fails closed. */
export function readOnlyRefusal(request: Pick<RuntimeApprovalRequest, "requestKind">): string | null {
  switch (request.requestKind) {
    case "file-read":
      return null;
    case "command":
      return "run a command";
    case "file-change":
      return "change files";
    default:
      return "use a tool";
  }
}

/** Whether `decision` may answer `request` on a run in `mode`: a read-only run
 *  only ever declines (or cancels) a request to run a command or change files,
 *  whoever answers it. */
export function approvalDecisionAllowed(
  mode: PermissionMode,
  request: Pick<RuntimeApprovalRequest, "requestKind">,
  decision: RuntimeApprovalDecision,
): boolean {
  return (
    mode !== "read-only" ||
    decision === "decline" ||
    decision === "cancel" ||
    readOnlyRefusal(request) === null
  );
}
