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
      { id: "gpt-5.6-luna", default: true, dispatchable: true, policyAllowed: true },
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
    const sections = Object.fromEntries(provider.sections.map((s) => [s.label, s.rows]));
    expect(sections.Models?.map((row) => row.value)).toEqual(["gpt-5.6-luna", "gpt-6-astra"]);
    expect(sections.Free).toEqual([]);
    expect(sections.Discovered).toEqual([
      {
        value: "gpt-future",
        label: "Future",
        disabled: true,
        description: "Discovered for this account; blocked by deployment policy",
      },
    ]);
    // The native-catalog refresh sits on the Models and Discovered headings.
    const actions = provider.sections.map((s) => (s.action ? renderToStaticMarkup(<>{s.action}</>) : ""));
    expect(actions[0]).toContain('aria-label="Refresh Codex models"');
    expect(actions[2]).toContain('aria-label="Refresh Codex models"');
  });

  test("an OpenCode entry keeps the Free lane as its own section with the shared refresh", () => {
    const provider = engineProvider("opencode", CATALOG, { ...refresh, refreshing: true });
    const sections = Object.fromEntries(provider.sections.map((s) => [s.label, s]));
    expect(sections.Models?.rows.map((row) => row.value)).toEqual(["openai/gpt-5.6-luna"]);
    expect(sections.Free?.rows.map((row) => row.value)).toEqual(["minimax/minimax-m3:free"]);
    expect(sections.Models?.action).toBeUndefined();
    const free = renderToStaticMarkup(<>{sections.Free?.action}</>);
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
