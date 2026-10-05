import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderKeyForm } from "@/app/(workspace)/settings/provider-key-form";
import type { ProviderConnectionMeta } from "@/app/(workspace)/settings/provider-connections-data";
import { engineProvider } from "@/components/chat/catalog-model-picker";
import {
  dismissStartFree,
  FREE_KEY_URL,
  keyRequiredError,
  missingKey,
  modelKeyState,
  StartFreePrompt,
  startFreeDismissed,
  startFreeModel,
  startFreeVisible,
} from "./start-free-prompt";

const OFFERED = ["anthropic", "openai", "openrouter", "cerebras", "opencode"];
const NO_KEYS = { connections: [], config: { offeredProviders: OFFERED, servedProviders: [] }, secretNames: [] };
const FREE = ["minimax/minimax-m3:free", "nvidia/nemotron:free"];

function connection(
  provider: ProviderConnectionMeta["provider"],
  status: ProviderConnectionMeta["status"] = "connected",
  authMethod: ProviderConnectionMeta["authMethod"] = "api_key",
): ProviderConnectionMeta {
  return {
    id: `${provider}-1`,
    provider,
    authMethod,
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
    expect(startFreeVisible(keys.needsKey, false, null)).toBe(true);
  });

  test("a key of any kind hides the card: the member's own, the organization's secret, or the deployment's", () => {
    for (const input of [
      { ...NO_KEYS, connections: [connection("anthropic")] },
      { ...NO_KEYS, secretNames: ["OPENAI_API_KEY"] },
      { ...NO_KEYS, config: { offeredProviders: OFFERED, servedProviders: ["opencode"] } },
    ]) {
      const keys = modelKeyState(input);
      expect(keys.needsKey).toBe(false);
      expect(startFreeVisible(keys.needsKey, false, null)).toBe(false);
    }
  });

  test("a rejected or revoked key and an unrelated secret serve nothing", () => {
    const keys = modelKeyState({
      ...NO_KEYS,
      connections: [connection("openrouter", "reauth_required"), connection("openai", "revoked")],
      secretNames: ["GITHUB_TOKEN"],
    });
    expect(keys.needsKey).toBe(true);
    expect(keys.served).toEqual([]);
    expect(keys.connections.find((row) => row.provider === "openrouter")?.status).toBe("reauth_required");
  });

  test("a provider the account is not offered counts for nothing, and no OpenRouter offer means no card", () => {
    const withheld = modelKeyState({ ...NO_KEYS, connections: [connection("openrouter")], config: { offeredProviders: ["openai"], servedProviders: [] } });
    expect(withheld).toMatchObject({ needsKey: false, openRouterMissing: false, onlyOpenRouter: false });
  });

  test("dismissal hides the card, but the form opened from the picker or the send error shows it again", () => {
    const keys = modelKeyState(NO_KEYS);
    expect(startFreeVisible(keys.needsKey, true, null)).toBe(false);
    expect(startFreeVisible(keys.needsKey, true, "openrouter")).toBe(true);
    // A model that needs another provider's key opens that form the same way.
    expect(startFreeVisible(false, true, "openai")).toBe(true);
  });
});

describe("which models a member can run", () => {
  test("a model needs its provider's key until the member, the organization or the deployment holds one", () => {
    const keys = modelKeyState({ ...NO_KEYS, connections: [connection("openrouter")] });
    expect(missingKey(keys, "opencode", "openai")).toBe("openai");
    expect(missingKey(keys, "chat", "openrouter")).toBeNull();
    expect(missingKey(keys, "opencode", "openrouter")).toBeNull();
    expect(missingKey(modelKeyState({ ...NO_KEYS, secretNames: ["OPENAI_API_KEY"] }), "opencode", "openai")).toBeNull();
    expect(missingKey(modelKeyState(NO_KEYS), "chat", "openrouter")).toBe("openrouter");
    expect(missingKey(modelKeyState(NO_KEYS), "claude", "anthropic")).toBe("anthropic");
  });

  test("a Codex account runs Codex without an OpenAI key, but not OpenCode's OpenAI models", () => {
    const keys = modelKeyState({ ...NO_KEYS, connections: [connection("openai", "connected", "chatgpt_oauth")] });
    expect(keys).toMatchObject({ codexAccount: true, served: [], needsKey: false });
    expect(missingKey(keys, "codex", "openai")).toBeNull();
    expect(missingKey(keys, "opencode", "openai")).toBe("openai");
  });

  test("nothing is marked while the keys are unknown, a model names no provider, or no member key could serve it", () => {
    const unknown = { ...modelKeyState(NO_KEYS), known: false };
    expect(missingKey(unknown, "chat", "openrouter")).toBeNull();
    expect(missingKey(modelKeyState(NO_KEYS), "opencode", undefined)).toBeNull();
    expect(missingKey(modelKeyState(NO_KEYS), "opencode", "opencode")).toBeNull();
  });

  test("the send refusal names the key the chosen model needs", () => {
    expect(keyRequiredError("openai")).toBe("This model runs on your own OpenAI key. Add it to send.");
  });
});

describe("a free model after the key is saved", () => {
  test("an OpenRouter key alone starts the composer on the first free model", () => {
    expect(startFreeModel(modelKeyState(NO_KEYS), [], false)).toBeNull();
    const saved = modelKeyState({ ...NO_KEYS, connections: [connection("openrouter")] });
    expect(saved).toMatchObject({ needsKey: false, openRouterMissing: false, onlyOpenRouter: true });
    expect(startFreeModel(saved, FREE, false)).toBe("minimax/minimax-m3:free");
  });

  test("a member with another key keeps a default they can run", () => {
    const keys = modelKeyState({ ...NO_KEYS, connections: [connection("openrouter"), connection("anthropic")] });
    expect(startFreeModel(keys, FREE, false)).toBeNull();
    expect(startFreeModel(modelKeyState({ ...NO_KEYS, connections: [connection("openrouter")] }), [], false)).toBeNull();
  });

  test("a default that needs a key the member lacks falls back to a free model they can run", () => {
    const keys = modelKeyState({ ...NO_KEYS, connections: [connection("openrouter"), connection("anthropic")] });
    expect(startFreeModel(keys, FREE, true)).toBe("minimax/minimax-m3:free");
    // No free model they can run: no fallback, the start-free card speaks instead.
    expect(startFreeModel(keys, [], true)).toBeNull();
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
      <StartFreePrompt formProvider={null} connection={null} onAdd={noop} onDismiss={noop} onSaved={saved} />,
    );
    expect(closed).toContain("Start free with OpenRouter.");
    expect(closed).toContain("Free models cost nothing on your own OpenRouter key.");
    expect(closed).toContain("Add OpenRouter key");
    expect(closed).toContain(`href="${FREE_KEY_URL}"`);
    expect(closed).toContain('target="_blank"');
    expect(closed).toContain('aria-label="Dismiss"');
    expect(closed).not.toContain('aria-label="OpenRouter API key"');

    const open = renderToStaticMarkup(
      <StartFreePrompt formProvider="openrouter" connection={null} onAdd={noop} onDismiss={noop} onSaved={saved} />,
    );
    expect(open).toContain('aria-label="OpenRouter API key"');
    expect(open).toContain("Save key");
    expect(open).not.toContain("Account email (optional)");
    // Settings keeps the same form with its optional email and label.
    const settings = renderToStaticMarkup(<ProviderKeyForm provider="openrouter" connection={null} onSaved={saved} />);
    expect(settings).toContain('aria-label="OpenRouter API key"');
    expect(settings).toContain("Account email (optional)");
  });

  test("a model that needs another provider's key opens that provider's form, without the free offer", () => {
    const html = renderToStaticMarkup(
      <StartFreePrompt formProvider="openai" connection={null} onAdd={noop} onDismiss={noop} onSaved={saved} />,
    );
    expect(html).toContain('aria-label="Add your OpenAI key"');
    expect(html).toContain("OpenAI models run on your own key.");
    expect(html).toContain('aria-label="OpenAI API key"');
    expect(html).not.toContain("Start free with OpenRouter.");
    expect(html).not.toContain(FREE_KEY_URL);
  });

  const model = (id: string, provider: string) => ({ id, default: false, dispatchable: true, policyAllowed: true, provider });
  const CATALOG = {
    models: { opencode: ["openai/gpt-5.6-luna", "claude-opus-5", ...FREE] },
    modelDetails: {
      opencode: [
        model("openai/gpt-5.6-luna", "openai"),
        model("claude-opus-5", "anthropic"),
        ...FREE.map((id) => model(id, "openrouter")),
      ],
    },
  };
  const access = (keys: ReturnType<typeof modelKeyState>, added: string[] = []) => ({
    missing: (engine: string, provider: string | undefined) => missingKey(keys, engine, provider),
    onAdd: (provider: string) => void added.push(provider),
  });

  test("with no OpenRouter key the picker's Free note is the same action, not a Settings link", () => {
    const added: string[] = [];
    const free = engineProvider("opencode", CATALOG, undefined, undefined, access(modelKeyState(NO_KEYS), added)).sections[1];
    expect(free?.note).toBe("Free on your own OpenRouter key.");
    expect(free?.noteAction?.label).toBe("Add OpenRouter key");
    free?.noteAction?.onAction();
    expect(added).toEqual(["openrouter"]);
    const settings = engineProvider("opencode", CATALOG).sections[1];
    expect(settings?.noteAction).toBeUndefined();
    expect(renderToStaticMarkup(<>{settings?.note}</>)).toContain('href="/settings"');
  });

  test("every model stays listed; one no key serves is tagged with its key and picking it opens that key's form", () => {
    const added: string[] = [];
    const keys = modelKeyState({ ...NO_KEYS, connections: [connection("anthropic")] });
    const [lineup, free] = engineProvider("opencode", CATALOG, undefined, undefined, access(keys, added)).sections;
    expect(lineup?.rows.map((row) => [row.value, row.unlock?.label ?? null])).toEqual([
      ["openai/gpt-5.6-luna", "Needs OpenAI key"],
      ["claude-opus-5", null],
    ]);
    // Free OpenRouter models follow the OpenRouter key.
    expect(free?.rows.map((row) => row.unlock?.label)).toEqual(["Needs OpenRouter key", "Needs OpenRouter key"]);
    lineup?.rows[0]?.unlock?.onUnlock();
    free?.rows[0]?.unlock?.onUnlock();
    expect(added).toEqual(["openai", "openrouter"]);
    // With an OpenRouter key the free lane opens up; without key access nothing is tagged.
    const withOpenRouter = modelKeyState({ ...NO_KEYS, connections: [connection("openrouter")] });
    expect(engineProvider("opencode", CATALOG, undefined, undefined, access(withOpenRouter)).sections[1]?.rows.some((row) => row.unlock))
      .toBe(false);
    expect(engineProvider("opencode", CATALOG).sections.flatMap((section) => section.rows).some((row) => row.unlock)).toBe(false);
  });
});
