import { describe, expect, test } from "bun:test";
import { assertOssSyncSafe } from "./assert-oss-sync-safe";

describe("Pro to OSS sync boundary", () => {
  test("accepts shared product paths", () => {
    expect(() => assertOssSyncSafe([
      "backend/src/middleware/org.ts",
      "frontend/components/chat/conversation.tsx",
    ])).not.toThrow();
  });

  test("rejects private deploy and production Terraform paths", () => {
    expect(() => assertOssSyncSafe(["deploy/hetzner/deploy-release.sh"]))
      .toThrow("OSS sync contains private paths");
    expect(() => assertOssSyncSafe(["infra/terraform/prod/main.tf"]))
      .toThrow("OSS sync contains private paths");
  });

  test("rejects planning notes and the production promote lane", () => {
    for (const path of [
      "plan/ux-audit-shell.md",
      ".github/workflows/promote.yml",
      ".github/workflows/gates.yml",
      ".github/workflows/images.yml",
      "deploy/promote.ts",
    ]) {
      expect(() => assertOssSyncSafe([path])).toThrow("OSS sync contains private paths");
    }
    expect(() => assertOssSyncSafe([".github/workflows/ci.yml", "deploy/compose/promotion.ts"])).not.toThrow();
  });

  test("rejects the licensed BoardUI Pro components", () => {
    expect(() => assertOssSyncSafe(["frontend/components/pro/agent-limits-card.tsx"]))
      .toThrow("OSS sync contains private paths");
  });
});
