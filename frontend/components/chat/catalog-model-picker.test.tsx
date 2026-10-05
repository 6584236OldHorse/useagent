import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { engineProvider, type ProviderCatalog } from "./catalog-model-picker";

/** The manifest shape after engineConfigFromCapabilityCatalog: dispatchable ids
 *  per engine plus the discovered details. */
const CATALOG: ProviderCatalog = {
  models: {
    codex: ["gpt-5.6-luna", "gpt-6-astra"],
    opencode: ["openai/gpt-5.6-luna", "minimax/minimax-m3:free"],
  },
  modelDetails: {
    codex: [
      {
        id: "gpt-5.6-luna",
        default: true,
        dispatchable: true,
        policyAllowed: true,
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
        defaultReasoningEffort: "medium",
      },
      { id: "gpt-6-astra", default: false, dispatchable: true, policyAllowed: true, displayName: "GPT-6 Astra" },
      {
        id: "gpt-future",
        default: false,
        dispatchable: false,
        policyAllowed: false,
        displayName: "Future",
        degradationReason: "model_not_allowed",
      },
    ],
    opencode: [],
  },
};

const refresh = { refreshing: false, onRefresh: () => {} };

describe("engine rail entries", () => {
  test("a Codex entry: the engine mark, the policy lineup, and the discovered row under its reason", () => {
    const provider = engineProvider("codex", CATALOG, refresh, "OpenAI agent · cloud");
    expect(provider.id).toBe("codex");
    expect(provider.label).toBe("Codex");
    expect(provider.caption).toBe("OpenAI agent · cloud");
    const [lineup, free, discovered] = provider.sections;
    // The plain lineup has no heading of its own: it follows the panel's Models title.
    expect(lineup?.label).toBe("");
    expect(lineup?.rows.map((row) => row.value)).toEqual(["gpt-5.6-luna", "gpt-6-astra"]);
    // The manifest's effort seam rides on the row; a model without one carries none.
    expect(lineup?.rows[0]).toMatchObject({
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "medium",
    });
    expect(lineup?.rows[1]?.efforts).toBeUndefined();
    expect(free?.label).toBe("Free");
    expect(free?.rows).toEqual([]);
    expect(discovered?.label).toBe("Discovered");
    expect(discovered?.rows).toEqual([
      {
        value: "gpt-future",
        label: "Future",
        disabled: true,
        description: "Discovered for this account; blocked by deployment policy",
      },
    ]);
    // The native-catalog refresh sits in the panel header, not on a section.
    expect(renderToStaticMarkup(<>{provider.action}</>)).toContain('aria-label="Refresh Codex models"');
    expect(provider.sections.every((s) => s.label === "Free" || s.action === undefined)).toBe(true);
  });

  test("an OpenCode entry keeps the Free lane as its own section with the shared refresh", () => {
    const provider = engineProvider("opencode", CATALOG, { ...refresh, refreshing: true });
    const [lineup, freeSection] = provider.sections;
    expect(lineup?.rows.map((row) => row.value)).toEqual(["openai/gpt-5.6-luna"]);
    expect(freeSection?.rows.map((row) => row.value)).toEqual(["minimax/minimax-m3:free"]);
    expect(provider.action).toBeUndefined();
    const free = renderToStaticMarkup(<>{freeSection?.action}</>);
    expect(free).toContain('aria-label="Refresh free models"');
    expect(free).toContain("animate-spin");
    expect(free).toContain("disabled");
  });

  test("an engine the manifest lists with no models is still a rail entry", () => {
    const provider = engineProvider("claude", CATALOG);
    expect(provider.label).toBe("Claude Code");
    expect(provider.sections.every((s) => s.rows.length === 0)).toBe(true);
  });
});
