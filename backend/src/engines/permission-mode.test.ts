import { describe, expect, test } from "bun:test";
import {
  approvalDecisionAllowed,
  configuredRuntimeMode,
  isPermissionMode,
  narrowerPermissionMode,
  PermissionModeUnsupportedError,
  permissionModeSupported,
  readOnlyRefusal,
  runtimeModeFor,
} from "./permission-mode";
import { buildRuntimeTurnStartCommand } from "./runtime-orchestration";

describe("permission modes", () => {
  test("the runtime is steered with the run's own mode; read only rides approval-required", () => {
    expect(runtimeModeFor("full-access")).toBe("full-access");
    expect(runtimeModeFor("approval-required")).toBe("approval-required");
    expect(runtimeModeFor("auto-accept-edits")).toBe("auto-accept-edits");
    expect(runtimeModeFor("auto")).toBe("auto");
    expect(runtimeModeFor("read-only")).toBe("approval-required");
    // Full access reaches the runtime's turn start as full access: nothing waits.
    const command = buildRuntimeTurnStartCommand(
      { runId: "run-1", threadId: "thread-1", model: undefined },
      "codex",
      "hello",
      "2026-09-13T00:00:00.000Z",
      true,
      runtimeModeFor("full-access"),
    );
    expect(command.runtimeMode).toBe("full-access");
    expect((command.bootstrap as { createThread: { runtimeMode: string } }).createThread.runtimeMode).toBe("full-access");
  });

  test("a read-only run refuses commands, file changes and unknown requests, and lets reads through", () => {
    expect(readOnlyRefusal({ requestKind: "file-read" })).toBeNull();
    expect(readOnlyRefusal({ requestKind: "command" })).toBe("run a command");
    expect(readOnlyRefusal({ requestKind: "file-change" })).toBe("change files");
    expect(readOnlyRefusal({ requestKind: "other" })).toBe("use a tool");
  });

  test("a person can only decline or cancel a write on a read-only run; every other mode answers freely", () => {
    expect(approvalDecisionAllowed("read-only", { requestKind: "file-change" }, "accept")).toBe(false);
    expect(approvalDecisionAllowed("read-only", { requestKind: "command" }, "acceptForSession")).toBe(false);
    expect(approvalDecisionAllowed("read-only", { requestKind: "command" }, "decline")).toBe(true);
    expect(approvalDecisionAllowed("read-only", { requestKind: "command" }, "cancel")).toBe(true);
    expect(approvalDecisionAllowed("read-only", { requestKind: "file-read" }, "accept")).toBe(true);
    expect(approvalDecisionAllowed("approval-required", { requestKind: "file-change" }, "accept")).toBe(true);
    expect(approvalDecisionAllowed("full-access", { requestKind: "command" }, "acceptForSession")).toBe(true);
  });

  test("only Pi cannot honour a mode below full access", () => {
    expect(permissionModeSupported("pi")).toBe(false);
    for (const engine of ["codex", "claude", "claude-sdk", "opencode", "daytona", "mock"]) {
      expect(permissionModeSupported(engine)).toBe(true);
    }
  });

  test("validates the wire enum and keeps the operator posture as the default", () => {
    expect(isPermissionMode("read-only")).toBe(true);
    expect(isPermissionMode("yolo")).toBe(false);
    expect(isPermissionMode(null)).toBe(false);
    expect(configuredRuntimeMode({})).toBe("full-access");
    expect(configuredRuntimeMode({ RUNTIME_MODE: "approval-required" })).toBe("approval-required");
  });

  test("a handed-off turn takes the narrower of the two modes, and an unsupported pairing names itself", () => {
    expect(narrowerPermissionMode("full-access", "read-only")).toBe("read-only");
    expect(narrowerPermissionMode("approval-required", "auto-accept-edits")).toBe("approval-required");
    expect(narrowerPermissionMode("auto", "full-access")).toBe("auto");
    expect(narrowerPermissionMode("full-access", "full-access")).toBe("full-access");
    const error = new PermissionModeUnsupportedError("pi", "read-only");
    expect(error.code).toBe("permission_mode_unsupported");
    expect(error.message).toContain("pi");
  });
});
