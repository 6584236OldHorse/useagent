import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { engineMarkFor } from "@/components/foundations/icons/vendor-marks";
import {
  applyPick,
  effortAfterPick,
  effortLabel,
  findPickerRow,
  ModelPicker,
  ModelPickerPanel,
  type ModelPickerProvider,
  nextFocusIndex,
  rowEffort,
  searchPickerRows,
} from "./model-picker";

/**
 * The popover portals to document.body, so the closed picker renders only its
 * chip on the server; the panel is rendered directly to pin the rail, row and
 * search contract. Focus movement and dismissal are walked in the browser.
 */

const PROVIDERS: ModelPickerProvider[] = [
  {
    id: "codex",
    label: "Codex",
    caption: "OpenAI agent · cloud",
    mark: engineMarkFor("codex"),
    sections: [
      {
        label: "",
        rows: [
          { value: "gpt-5.6-luna", label: "GPT-5.6 Luna · Fast", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
          { value: "gpt-6-astra", label: "GPT-6 Astra", efforts: ["low", "high", "max"], defaultEffort: "high" },
        ],
      },
      {
        label: "Discovered",
        rows: [{ value: "gpt-future", label: "GPT Future", description: "Currently unavailable", disabled: true }],
      },
    ],
  },
  {
    id: "claude",
    label: "Claude Code",
    mark: engineMarkFor("claude"),
    sections: [{ label: "", rows: [{ value: "claude-opus-5", label: "Opus 5" }] }],
  },
  {
    id: "opencode",
    label: "OpenCode",
    mark: engineMarkFor("opencode"),
    sections: [
      { label: "", rows: [{ value: "claude-opus-5", label: "Opus 5" }] },
      { label: "Free", rows: [] },
    ],
  },
  {
    id: "lab-engine",
    label: "Lab engine",
    mark: engineMarkFor("lab-engine"),
    sections: [{ label: "", rows: [{ value: "lab/sample", label: "Sample" }] }],
  },
];

const panel = (over: Partial<Parameters<typeof ModelPickerPanel>[0]> = {}) =>
  renderToStaticMarkup(
    <ModelPickerPanel
      providers={PROVIDERS}
      value="gpt-6-astra"
      providerId="codex"
      browsing={null}
      onBrowse={() => {}}
      query=""
      onQueryChange={() => {}}
      onPick={() => {}}
      {...over}
    />,
  );

describe("model picker panel", () => {
  test("the rail carries one tab per provider with the selection's provider raised", () => {
    const html = panel();
    expect(html).toContain('aria-label="Providers"');
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect(html).toContain('role="tab" aria-selected="true" aria-label="Codex"');
    // The name comes from the design system tooltip on hover or focus, not a
    // slow native title; the tab keeps its accessible name.
    expect(html).not.toContain('title="Codex · OpenAI agent · cloud"');
    expect(html).toContain('aria-selected="false" aria-label="Claude Code"');
  });

  test("rows are radios; only the selected row is checked and a discovered row is disabled", () => {
    const html = panel();
    expect(html).toContain('role="radiogroup" aria-label="Codex models"');
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html).toContain('aria-checked="true" aria-label="Codex GPT-6 Astra"');
    expect(html).toContain('title="GPT Future: Currently unavailable"');
    expect(html).toContain('aria-label="Codex GPT Future" title="GPT Future: Currently unavailable" disabled=""');
    // The plain lineup follows the panel title with no heading of its own; the
    // other sections carry theirs; an empty section is not drawn.
    expect(html.match(/>Models</g)).toHaveLength(1);
    expect(html).toContain(">Discovered<");
    expect(html).not.toContain(">Free<");
    expect(html).toContain('placeholder="Quick search"');
  });

  test("the rail browses another provider without moving the selection", () => {
    const html = panel({ browsing: "claude" });
    expect(html).toContain('aria-selected="true" aria-label="Claude Code"');
    expect(html).toContain('aria-label="Claude Code models"');
    expect(html).not.toContain('aria-checked="true"');
  });

  test("a model id shared by two engines is checked only under its own engine", () => {
    const html = panel({ value: "claude-opus-5", providerId: "opencode", browsing: "claude" });
    expect(html).toContain('aria-checked="false" aria-label="Claude Code Opus 5"');
    expect(findPickerRow(PROVIDERS, "claude-opus-5", "opencode")?.provider.id).toBe("opencode");
    expect(findPickerRow(PROVIDERS, "claude-opus-5")?.provider.id).toBe("claude");
  });

  test("quick search filters every provider's rows by label and id, naming the provider", () => {
    const html = panel({ query: "opus" });
    expect(html).toContain('aria-label="Matching models"');
    expect(html.match(/role="radio"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Claude Code Opus 5"');
    expect(html).toContain('aria-label="OpenCode Opus 5"');
    expect(html).toContain(">Claude Code</span>");
    expect(panel({ query: "nothing-like-this" })).toContain("No models match");
    expect(searchPickerRows(PROVIDERS, "astra").map((m) => m.row.value)).toEqual(["gpt-6-astra"]);
    expect(searchPickerRows(PROVIDERS, "lab/").map((m) => m.provider.id)).toEqual(["lab-engine"]);
    expect(searchPickerRows(PROVIDERS, "").length).toBe(6);
  });

  test("an engine without a vendor mark draws the neutral glyph", () => {
    const neutral = renderToStaticMarkup(<>{(() => { const M = engineMarkFor("lab-engine"); return <M />; })()}</>);
    expect(panel({ browsing: "lab-engine" })).toContain(neutral.slice(0, 60));
  });

  test("arrow keys move within the group and wrap; Home and End reach the ends", () => {
    expect(nextFocusIndex("ArrowDown", 0, 3)).toBe(1);
    expect(nextFocusIndex("ArrowDown", 2, 3)).toBe(0);
    expect(nextFocusIndex("ArrowUp", 0, 3)).toBe(2);
    expect(nextFocusIndex("Home", 2, 3)).toBe(0);
    expect(nextFocusIndex("End", 0, 3)).toBe(2);
    expect(nextFocusIndex("Enter", 1, 3)).toBeNull();
    expect(nextFocusIndex("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("model picker effort selector", () => {
  test("the selected row alone carries the effort chip, at the model's default until chosen", () => {
    const html = panel();
    expect(html.match(/aria-label="Effort: /g)).toHaveLength(1);
    expect(html).toContain('aria-label="Effort: High"');
    expect(panel({ effort: "max" })).toContain('aria-label="Effort: Max"');
    // A level the model does not offer falls back to its default.
    expect(panel({ effort: "xhigh" })).toContain('aria-label="Effort: High"');
    // A browsed provider shows no chip: nothing is selected there.
    expect(panel({ browsing: "claude" })).not.toContain("aria-label=\"Effort: ");
  });

  test("a model without levels shows no chip even when selected", () => {
    const html = panel({ value: "claude-opus-5", providerId: "claude", browsing: "claude" });
    expect(html).toContain('aria-checked="true"');
    expect(html).not.toContain("aria-label=\"Effort: ");
  });

  test("picking a model carries the level its row will show, never a stale one", () => {
    // Same level offered by the new model: kept.
    expect(effortAfterPick(PROVIDERS, "gpt-5.6-luna", "codex", "high")).toBe("high");
    // Not offered there: the new model's default, so the chip and the sent value agree.
    expect(effortAfterPick(PROVIDERS, "gpt-6-astra", "codex", "xhigh")).toBe("high");
    // No level chosen yet: the default.
    expect(effortAfterPick(PROVIDERS, "gpt-5.6-luna", "codex", null)).toBe("medium");
    // A model without levels carries none.
    expect(effortAfterPick(PROVIDERS, "claude-opus-5", "claude", "high")).toBe("");
    expect(effortAfterPick(PROVIDERS, "unknown", "codex", "high")).toBe("");
  });

  test("levels read in sentence case and resolve against the row", () => {
    expect(["low", "medium", "high", "xhigh", "max", "ultra", "custom"].map(effortLabel)).toEqual([
      "Low", "Medium", "High", "Extra high", "Max", "Ultra", "Custom",
    ]);
    const row = { value: "m", label: "M", efforts: ["low", "high"], defaultEffort: "high" };
    expect(rowEffort(row, null)).toBe("high");
    expect(rowEffort(row, "low")).toBe("low");
    expect(rowEffort(row, "max")).toBe("high");
    expect(rowEffort({ value: "m", label: "M", efforts: ["low"] }, null)).toBe("low");
    expect(rowEffort({ value: "m", label: "M" }, "low")).toBeNull();
  });
});

describe("model picker locked rows", () => {
  const unlocked: string[] = [];
  const LOCKED: ModelPickerProvider[] = [
    {
      ...PROVIDERS[2]!,
      sections: [
        {
          label: "",
          rows: [
            { value: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna", unlock: { label: "Needs OpenAI key", onUnlock: () => unlocked.push("openai") } },
            { value: "claude-opus-5", label: "Opus 5" },
          ],
        },
      ],
    },
  ];

  test("a model the member cannot run stays listed, tagged with the key it needs instead of a radio dot", () => {
    const html = panel({ providers: LOCKED, value: "claude-opus-5", providerId: "opencode" });
    expect(html).toContain('aria-label="OpenCode GPT-5.6 Luna, Needs OpenAI key"');
    expect(html).toContain(">Needs OpenAI key</span>");
    expect(html).toContain('aria-label="OpenCode Opus 5"');
  });

  test("a section note can carry an action, drawn as a button after the note", () => {
    const withAction: ModelPickerProvider[] = [
      {
        ...LOCKED[0]!,
        sections: [
          { label: "Free", note: "Free on your own OpenRouter key.", noteAction: { label: "Add OpenRouter key", onAction: () => {} }, rows: [{ value: "m:free", label: "M" }] },
        ],
      },
    ];
    const html = panel({ providers: withAction, value: "m:free", providerId: "opencode" });
    expect(html).toContain("Free on your own OpenRouter key.");
    expect(html).toMatch(/<button type="button" class="[^"]*underline[^"]*">Add OpenRouter key<\/button>/);
  });

  test("picking it opens the key form and never selects it; an open row selects as before", () => {
    const picks: string[] = [];
    const efforts: string[] = [];
    applyPick(LOCKED, "openai/gpt-5.6-luna", "opencode", null, (id) => picks.push(id), (level) => efforts.push(level));
    expect(unlocked).toEqual(["openai"]);
    expect(picks).toEqual([]);
    expect(efforts).toEqual([]);
    applyPick(LOCKED, "claude-opus-5", "opencode", null, (id) => picks.push(id), (level) => efforts.push(level));
    expect(picks).toEqual(["claude-opus-5"]);
    expect(efforts).toEqual([""]);
  });
});

describe("model picker chip", () => {
  test("the trigger names the selection with its vendor mark and folds the label below sm", () => {
    const html = renderToStaticMarkup(
      <ModelPicker providers={PROVIDERS} value="gpt-6-astra" providerId="codex" onChange={() => {}} />,
    );
    expect(html).toContain('data-testid="model-picker"');
    expect(html).toContain('aria-label="Model: GPT-6 Astra"');
    expect(html).toContain("max-sm:sr-only");
    expect(html).toContain(">GPT-6 Astra<");
    // Closed: the panel is not in the static tree.
    expect(html).not.toContain('role="tablist"');
  });
});
