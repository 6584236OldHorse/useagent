import { describe, expect, test } from "bun:test";
import {
  autoApplyEdits,
  autoApplyEditsHint,
  choiceForMode,
  modeForChoice,
  modeWithAutoApply,
  permissionModeFor,
  permissionModeOffered,
} from "./permission-mode";

describe("permission mode model", () => {
  test("every stored mode maps to a choice and the edits switch folds into Guard", () => {
    expect(choiceForMode("read-only")).toBe("read-only");
    expect(choiceForMode("approval-required")).toBe("guard");
    expect(choiceForMode("auto-accept-edits")).toBe("guard");
    expect(choiceForMode("full-access")).toBe("full-access");
    expect(choiceForMode("auto")).toBeNull();
    expect(modeForChoice("guard", false)).toBe("approval-required");
    expect(modeForChoice("guard", true)).toBe("auto-accept-edits");
    expect(modeForChoice("read-only", true)).toBe("read-only");
    expect(modeForChoice("full-access", true)).toBe("full-access");
    expect(modeWithAutoApply("approval-required", true)).toBe("auto-accept-edits");
    expect(modeWithAutoApply("auto-accept-edits", false)).toBe("approval-required");
    expect(modeWithAutoApply("read-only", true)).toBe("read-only");
    expect(modeWithAutoApply("full-access", true)).toBe("full-access");
    expect(autoApplyEdits("auto-accept-edits")).toBe(true);
    expect(autoApplyEdits("approval-required")).toBe(false);
  });

  test("an engine that cannot ask first is offered Full access only, and a narrower pick falls back to it", () => {
    expect(permissionModeOffered("pi", "read-only")).toBe(false);
    expect(permissionModeOffered("pi", "approval-required")).toBe(false);
    expect(permissionModeOffered("pi", "auto-accept-edits")).toBe(false);
    expect(permissionModeOffered("pi", "full-access")).toBe(true);
    expect(permissionModeOffered("codex", "read-only")).toBe(true);
    expect(permissionModeOffered(undefined, "auto-accept-edits")).toBe(true);
    expect(permissionModeFor("pi", "read-only")).toBe("full-access");
    expect(permissionModeFor("pi", "full-access")).toBe("full-access");
    expect(permissionModeFor("codex", "read-only")).toBe("read-only");
  });

  test("the edits switch says what it really lets through on each engine", () => {
    expect(autoApplyEditsHint("codex")).toBe("File edits, and commands that stay inside the workspace, go through without asking.");
    expect(autoApplyEditsHint("opencode")).toBe("File edits go through without asking; commands still ask.");
    expect(autoApplyEditsHint(undefined)).toBe("File edits go through without asking; commands still ask.");
  });
});
