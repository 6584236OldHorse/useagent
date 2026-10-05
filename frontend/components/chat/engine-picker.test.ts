import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { CapabilityCatalog } from "@/lib/capability-catalog";
import {
  applyLocalLoginOffers,
  engineConfigFromCapabilityCatalog,
  engineRuntimeCaption,
  pickerEngineOptions,
} from "./engine-picker";

/** The shape GET /api/capabilities returns when chat and opencode are configured. */
const MANIFEST: CapabilityCatalog = {
  version: 1,
  scope: "pre_run",
  bots: true,
  engines: [
    {
      id: "chat",
      configured: true,
      ready: true,
      defaultModel: "anthropic/claude-sonnet-5",
      models: [{
        id: "anthropic/claude-sonnet-5",
        default: true,
        dispatchable: true,
        policyAllowed: true,
      }],
      runtime: { kind: "direct", label: "direct model · no sandbox" },
    },
    {
      id: "opencode",
      configured: true,
      ready: true,
      defaultModel: "openai/gpt-5.6-luna",
      models: [{
        id: "openai/gpt-5.6-luna",
        default: true,
        dispatchable: true,
        policyAllowed: true,
      }],
      runtime: { kind: "native", label: "any model · cloud" },
    },
    {
      id: "claude",
      configured: false,
      ready: false,
      defaultModel: "claude-opus-5",
      models: [],
      runtime: { kind: "acp_compat", label: "Anthropic agent · cloud" },
    },
  ],
  tools: { gatewayConfigured: true, declared: [] },
  nativeSlashCommands: { catalog: "session_runtime", currentRun: null },
};

describe("new-thread engine picker", () => {
  test("offers every engine the manifest configured, chat included", () => {
    const config = engineConfigFromCapabilityCatalog(MANIFEST);
    expect(config.engines).toEqual(["chat", "opencode"]);
    expect(pickerEngineOptions(config.engines).map((e) => e.id)).toEqual(["opencode", "chat"]);
    expect(pickerEngineOptions(config.engines).map((e) => e.label)).toEqual(["OpenCode", "Chat"]);
  });

  test("chat says what it is: no computer, no tools", () => {
    const config = engineConfigFromCapabilityCatalog(MANIFEST);
    expect(engineRuntimeCaption("chat", config.runtimes.chat, config.readiness.chat)).toBe(
      "Chat only: answers from context, no computer or tools",
    );
  });

  test("offers a configured degraded engine through this viewer's machine login", () => {
    const catalog: CapabilityCatalog = {
      ...MANIFEST,
      engines: [
        ...MANIFEST.engines,
        {
          id: "codex",
          configured: true,
          ready: false,
          degradationReason: "provider_unhealthy",
          defaultModel: "gpt-5.6-luna",
          models: [
            {
              id: "gpt-5.6-luna",
              default: true,
              dispatchable: false,
              policyAllowed: true,
            },
            {
              id: "blocked",
              default: false,
              dispatchable: false,
              policyAllowed: false,
            },
          ],
          runtime: { kind: "t3", label: "OpenAI agent · cloud" },
        },
      ],
    };
    const config = applyLocalLoginOffers(engineConfigFromCapabilityCatalog(catalog), [
      "codex",
      "claude",
    ]);

    expect(config.localLoginOffered).toEqual(["codex"]);
    expect(config.readiness.codex).toMatchObject({
      ready: false,
      reason: "provider_unhealthy",
    });
    expect(config.models.codex).toEqual(["gpt-5.6-luna"]);
    expect(engineRuntimeCaption("codex", config.runtimes.codex, config.readiness.codex, true)).toBe(
      "Codex · machine login available",
    );
  });

  test("the caption says local while the user's own machine runs new threads", () => {
    const config = engineConfigFromCapabilityCatalog(MANIFEST);
    expect(engineRuntimeCaption("opencode", config.runtimes.opencode, config.readiness.opencode, false, true)).toBe(
      "any model · local",
    );
    expect(engineRuntimeCaption("opencode", config.runtimes.opencode, config.readiness.opencode, false, false)).toBe(
      "any model · cloud",
    );
  });

  test("the composer reads its options from the manifest-driven helper", () => {
    const composer = readFileSync(
      new URL("../../app/(workspace)/agent/new/new-task-composer.tsx", import.meta.url),
      "utf8",
    );
    expect(composer).toContain("pickerEngineOptions(enabledEngines)");
    expect(composer).toContain("engineConfig.modelDetails[engineId]");
    expect(composer).not.toContain('e.id !== "chat"');
  });
});
