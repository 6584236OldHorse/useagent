// The per-run permission mode as the composers see it, presentation-free: the
// wire's PermissionMode (@useagent/agent-client), the three choices a person is
// offered with the edits switch folded into Guard, which of them an engine can
// honour, and the props every control that offers the mode takes from a
// composer. The chip in components/pro renders it today; a different control
// renders the same contract without touching this file. No "use client".
//
// Submit wiring lives beside it: ComposerSubmit (composer.tsx) carries
// `permissionMode`, replyRunBody (reply-run-body.ts) and createThreadMessage
// (lib/create-run.ts) send it as `permission_mode`, and the new-task composer
// sends the same field on POST /api/runs.

import type { PermissionMode } from "@useagent/agent-client/wire";

export type { PermissionMode };

/** The three choices a person is offered. Guard folds the edits switch into the
 *  stored mode ("approval-required" or "auto-accept-edits"); "auto" is an
 *  operator posture a control shows but never offers. */
export type PermissionChoice = "read-only" | "guard" | "full-access";

/** The choice a stored mode belongs to; null for the operator-only "auto". */
export function choiceForMode(mode: PermissionMode): PermissionChoice | null {
  if (mode === "approval-required" || mode === "auto-accept-edits") return "guard";
  return mode === "auto" ? null : mode;
}

export function autoApplyEdits(mode: PermissionMode): boolean {
  return mode === "auto-accept-edits";
}

/** The stored mode after picking a choice; Guard keeps the edits switch where it was. */
export function modeForChoice(choice: PermissionChoice, applyEdits: boolean): PermissionMode {
  if (choice === "guard") return applyEdits ? "auto-accept-edits" : "approval-required";
  return choice;
}

/** The stored mode after flipping the edits switch; only Guard has edits to auto-apply. */
export function modeWithAutoApply(mode: PermissionMode, applyEdits: boolean): PermissionMode {
  if (mode !== "approval-required" && mode !== "auto-accept-edits") return mode;
  return applyEdits ? "auto-accept-edits" : "approval-required";
}

/** Whether an engine can honour a mode, mirroring the control plane's admission
 *  rule (permissionModeSupported): Pi's bridge mediates no approvals, so nothing
 *  below Full access can be enforced there and the run would be refused. */
export function permissionModeOffered(engine: string | undefined, mode: PermissionMode): boolean {
  return mode === "full-access" || engine !== "pi";
}

/** The mode a composer sends for `engine`: the one chosen when the engine can
 *  honour it, else Full access. The choice itself survives an engine switch
 *  and back. */
export function permissionModeFor(engine: string | undefined, mode: PermissionMode): PermissionMode {
  return permissionModeOffered(engine, mode) ? mode : "full-access";
}

/** What the edits switch really lets through on each engine: the resident runtime
 *  maps it to the engine's own policy, and Codex's "workspace-write" policy also
 *  runs commands that stay inside the workspace without asking. */
export function autoApplyEditsHint(engine: string | undefined): string {
  return engine === "codex"
    ? "File edits, and commands that stay inside the workspace, go through without asking."
    : "File edits go through without asking; commands still ask.";
}

/** What every control that offers the mode takes from a composer. */
export interface PermissionModeControlProps {
  /** The mode the next submission carries. */
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  /** The engine the run will use: it decides which modes are offered, and the edits switch reads differently on Codex. */
  engine?: string;
  /** The next submission cannot carry a mode (it resumes a running turn): show it, do not offer a change. */
  disabled?: boolean;
}
