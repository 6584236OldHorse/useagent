"use client";

import { useState } from "react";
import { ModelPicker, type ModelPickerProvider } from "@/components/pro/model-picker";
import { engineMarkFor } from "@/components/foundations/icons/vendor-marks";

/** Fixture rail: three engines with a lineup each, one free row, one
 *  discovered-but-blocked row, plus an engine no mark is drawn for. */
export const SAMPLE_PROVIDERS: ModelPickerProvider[] = [
  {
    id: "codex",
    label: "Codex",
    caption: "OpenAI agent · cloud",
    mark: engineMarkFor("codex"),
    sections: [
      {
        label: "Models",
        rows: [
          { value: "gpt-5.6-luna", label: "GPT-5.6 Luna · Fast" },
          { value: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
          { value: "gpt-6-astra", label: "GPT-6 Astra" },
        ],
      },
      {
        label: "Discovered",
        rows: [
          {
            value: "gpt-future",
            label: "GPT Future",
            description: "Discovered for this account; blocked by deployment policy",
            disabled: true,
          },
        ],
      },
    ],
  },
  {
    id: "claude",
    label: "Claude Code",
    caption: "Anthropic agent · cloud",
    mark: engineMarkFor("claude"),
    sections: [
      {
        label: "Models",
        rows: [
          { value: "claude-opus-5", label: "Opus 5" },
          { value: "claude-sonnet-5", label: "Sonnet 5" },
          { value: "claude-haiku-4-5", label: "Haiku 4.5" },
        ],
      },
    ],
  },
  {
    id: "opencode",
    label: "OpenCode",
    caption: "any model · cloud",
    mark: engineMarkFor("opencode"),
    sections: [
      {
        label: "Models",
        rows: [
          { value: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna · Fast" },
          { value: "google/gemini-3.7-flash", label: "Gemini 3.7 Flash · Fast" },
          { value: "moonshotai/kimi-k3", label: "Kimi K3" },
        ],
      },
      { label: "Free", rows: [{ value: "minimax/minimax-m3:free", label: "MiniMax M3" }] },
    ],
  },
  {
    id: "lab-engine",
    label: "Lab engine",
    mark: engineMarkFor("lab-engine"),
    sections: [{ label: "Models", rows: [{ value: "lab/sample-1", label: "Sample 1" }] }],
  },
];

export function ModelPickerShowcase() {
  const [selection, setSelection] = useState({ model: "gpt-5.6-terra", provider: "codex" });
  return (
    <section className="flex flex-col gap-4 border-t border-border-button-default py-8">
      <p className="text-mono-label text-text-tertiary">
        Model picker - provider rail, quick search, radio rows (components/pro)
      </p>
      <div
        data-lab="model-picker"
        className="flex h-9 w-fit items-center rounded-2xl border border-border-button-default bg-background-primary-default px-2"
      >
        <ModelPicker
          providers={SAMPLE_PROVIDERS}
          value={selection.model}
          providerId={selection.provider}
          onChange={(model, provider) => setSelection({ model, provider })}
          placement="bottom end"
        />
      </div>
      <p className="text-caption-1-regular text-text-tertiary">
        Selected: {selection.provider} / {selection.model}
      </p>
    </section>
  );
}
