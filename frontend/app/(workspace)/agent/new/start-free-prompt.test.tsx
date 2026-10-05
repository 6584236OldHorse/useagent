import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderKeyForm } from "@/app/(workspace)/settings/provider-key-form";
import type { ProviderConnectionMeta } from "@/app/(workspace)/settings/provider-connections-data";
import { engineProvider } from "@/components/chat/catalog-model-picker";
import {
  dismissStartFree,
  FREE_KEY_URL,
  FreeLaneNote,
  modelKeyState,
  StartFreePrompt,
  startFreeDismissed,
  startFreeModel,
  startFreeVisible,
} from "./start-free-prompt";

const OFFERED = ["anthropic", "openai", "openrouter", "cerebras", "opencode"];
const NO_KEYS = { connections: [], config: { offeredProviders: OFFERED, servedProviders: [] }, secretNames: [] };
const MODELS = { opencode: ["openai/gpt-5.6-luna", "minimax/minimax-m3:free", "nvidia/nemotron:free"] };

function connection(
  provider: ProviderConnectionMeta["provider"],
  status: ProviderConnectionMeta["status"] = "connected",
): ProviderConnectionMeta {
  return {
    id: `${provider}-1`,
    provider,
    authMethod: "api_key",
    status,
    metadata: {},
    createdAt: "2026-10-02T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    revokedAt: null,
  };
}

describe("who needs a key", () => {
  test("no key anywhere: the card shows, the send is refused, the picker offers the key", () => {
    const keys = modelKeyState(NO_KEYS);
    expect(keys).toMatchObject({ needsKey: true, openRouterMissing: true, onlyOpenRouter: false });
    expect(startFreeVisible(keys, false, false)).toBe(true);
  });

  test("a key of any kind hides the card: the member's own, the organization's secret, or the deployment's", () => {
    for (const input of [
      { ...NO_KEYS, connections: [connection("anthropic")] },
      { ...NO_KEYS, secretNames: ["OPENAI_API_KEY"] },
      { ...NO_KEYS, config: { offeredProviders: OFFERED, servedProviders: ["opencode"] } },
    ]) {
      const keys = modelKeyState(input);
      expect(keys.needsKey).toBe(false);
      expect(startFreeVisible(keys, false, false)).toBe(false);
    }
  });

  test("a rejected or revoked key and an unrelated secret serve nothing", () => {
    const keys = modelKeyState({
      ...NO_KEYS,
      connections: [connection("openrouter", "reauth_required"), connection("openai", "revoked")],
      secretNames: ["GITHUB_TOKEN"],
    });
    expect(keys.needsKey).toBe(true);
    expect(keys.openRouterConnection?.status).toBe("reauth_required");
  });

  test("a provider the account is not offered counts for nothing, and no OpenRouter offer means no card", () => {
    const withheld = modelKeyState({ ...NO_KEYS, connections: [connection("openrouter")], config: { offeredProviders: ["openai"], servedProviders: [] } });
    expect(withheld).toMatchObject({ needsKey: false, openRouterMissing: false, onlyOpenRouter: false });
  });

  test("dismissal hides the card, but the form opened from the picker or the send error shows it again", () => {
    const keys = modelKeyState(NO_KEYS);
    expect(startFreeVisible(keys, true, false)).toBe(false);
    expect(startFreeVisible(keys, true, true)).toBe(true);
  });
});

describe("a free model after the key is saved", () => {
  test("an OpenRouter key alone starts the composer on the first free model", () => {
    expect(startFreeModel(modelKeyState(NO_KEYS), MODELS)).toBeNull();
    const saved = modelKeyState({ ...NO_KEYS, connections: [connection("openrouter")] });
    expect(saved).toMatchObject({ needsKey: false, openRouterMissing: false, onlyOpenRouter: true });
    expect(startFreeModel(saved, MODELS)).toBe("minimax/minimax-m3:free");
  });

  test("a member with another key keeps the composer's own default", () => {
    const keys = modelKeyState({ ...NO_KEYS, connections: [connection("openrouter"), connection("anthropic")] });
    expect(startFreeModel(keys, MODELS)).toBeNull();
    expect(startFreeModel(modelKeyState({ ...NO_KEYS, connections: [connection("openrouter")] }), {})).toBeNull();
  });
});

describe("dismissal is remembered per member", () => {
  const original = globalThis.window;
  afterEach(() => {
    globalThis.window = original;
  });

  test("one member's dismissal does not hide another's card", () => {
    const store = new Map<string, string>();
    globalThis.window = {
      localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) },
    } as unknown as Window & typeof globalThis;
    expect(startFreeDismissed("user-a")).toBe(false);
    dismissStartFree("user-a");
    expect(startFreeDismissed("user-a")).toBe(true);
    expect(startFreeDismissed("user-b")).toBe(false);
  });

  test("a browser that refuses storage shows the card and never throws", () => {
    const refuse = () => {
      throw new Error("denied");
    };
    globalThis.window = { localStorage: { getItem: refuse, setItem: refuse } } as unknown as Window & typeof globalThis;
    expect(() => dismissStartFree("user-a")).not.toThrow();
    expect(startFreeDismissed("user-a")).toBe(false);
  });
});

describe("the card and the picker action", () => {
  const noop = () => {};
  const saved = async () => {};

  test("the card offers the key form and a free key in a new tab, and opens the Settings form in place", () => {
    const closed = renderToStaticMarkup(
      <StartFreePrompt formOpen={false} connection={null} onAdd={noop} onDismiss={noop} onSaved={saved} />,
    );
    expect(closed).toContain("Start free with OpenRouter.");
    expect(closed).toContain("Free models cost nothing on your own OpenRouter key.");
    expect(closed).toContain("Add OpenRouter key");
    expect(closed).toContain(`href="${FREE_KEY_URL}"`);
    expect(closed).toContain('target="_blank"');
    expect(closed).toContain('aria-label="Dismiss"');
    expect(closed).not.toContain('aria-label="OpenRouter API key"');

    const open = renderToStaticMarkup(
      <StartFreePrompt formOpen connection={null} onAdd={noop} onDismiss={noop} onSaved={saved} />,
    );
    expect(open).toContain('aria-label="OpenRouter API key"');
    expect(open).toContain("Save key");
    expect(open).not.toContain("Account email (optional)");
    // Settings keeps the same form with its optional email and label.
    const settings = renderToStaticMarkup(<ProviderKeyForm provider="openrouter" connection={null} onSaved={saved} />);
    expect(settings).toContain('aria-label="OpenRouter API key"');
    expect(settings).toContain("Account email (optional)");
  });

  test("with no OpenRouter key the picker's Free note is the same action, not a Settings link", () => {
    const catalog = { models: MODELS, modelDetails: {} };
    const note = (freeNote?: React.ReactNode) =>
      renderToStaticMarkup(<>{engineProvider("opencode", catalog, undefined, undefined, freeNote).sections[1]?.note}</>);
    const actionable = note(<FreeLaneNote onAdd={noop} />);
    expect(actionable).toContain("Free on your own OpenRouter key.");
    expect(actionable).toContain('<button type="button"');
    expect(actionable).toContain("Add OpenRouter key");
    expect(actionable).not.toContain('href="/settings"');
    expect(note()).toContain('href="/settings"');
  });
});
