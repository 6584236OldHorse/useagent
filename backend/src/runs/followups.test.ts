// Pure-function tests for follow-up suggestion parsing + gating (no DB, no
// network: generation/persist paths are best-effort by contract and exercised
// by the finalize integration surface).
// Run: `bun test src/runs/followups.test.ts` (from backend/).

import { describe, expect, test } from "bun:test";
import {
  followupsEnabled,
  followupsModel,
  parseFollowupSuggestions,
  recordRunFollowups,
} from "./followups";

describe("parseFollowupSuggestions", () => {
  test("parses a plain JSON array, trimmed", () => {
    expect(parseFollowupSuggestions('["What next?", "  Add tests?  "]')).toEqual([
      "What next?",
      "Add tests?",
    ]);
  });

  test("tolerates a fenced code block", () => {
    expect(parseFollowupSuggestions('```json\n["A?", "B?"]\n```')).toEqual(["A?", "B?"]);
  });

  test("caps at three and dedupes case-insensitively", () => {
    expect(parseFollowupSuggestions('["a?", "A?", "b?", "c?", "d?"]')).toEqual([
      "a?",
      "b?",
      "c?",
    ]);
  });

  test("drops non-strings and empties; [] on prose or bad JSON", () => {
    expect(parseFollowupSuggestions('["ok?", 42, "", null]')).toEqual(["ok?"]);
    expect(parseFollowupSuggestions("Here are some ideas: ...")).toEqual([]);
    expect(parseFollowupSuggestions('{"suggestions": ["x"]}')).toEqual([]);
  });

  test("truncates overlong suggestions to 120 chars", () => {
    const long = "w".repeat(300);
    expect(parseFollowupSuggestions(`["${long}"]`)[0]).toHaveLength(120);
  });
});

describe("gating", () => {
  test("requires explicit opt-in", () => {
    expect(followupsEnabled({})).toBe(false);
    expect(followupsEnabled({ OPENROUTER_API_KEY: "house-only" })).toBe(false);
    expect(followupsEnabled({ FOLLOWUPS_ENABLED: "1" })).toBe(true);
  });

  test("model override wins over the cheap default", () => {
    expect(followupsModel({})).toBe("anthropic/claude-haiku-4.5");
    expect(followupsModel({ FOLLOWUPS_MODEL: "z-ai/glm-5.2" })).toBe("z-ai/glm-5.2");
  });

  test("fails closed without a tenant credential and rejects a house key", async () => {
    let fetchCalls = 0;
    const run = {
      id: "run-1",
      threadId: "thread-1",
      orgId: "org-1",
      userId: "user-1",
      prompt: "Explain the change",
    };
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return new Response();
    }) as unknown as typeof fetch;

    await recordRunFollowups(run, "A sufficiently long completed answer for suggestions.", {
      env: { FOLLOWUPS_ENABLED: "1", OPENROUTER_API_KEY: "house-key" },
      resolveCredential: async () => null,
      fetch: fetchImpl,
    });
    await recordRunFollowups(run, "A sufficiently long completed answer for suggestions.", {
      env: { FOLLOWUPS_ENABLED: "1", OPENROUTER_API_KEY: "house-key" },
      resolveCredential: async () => ({ value: "house-key", source: "backend_env" }),
      fetch: fetchImpl,
    });

    expect(fetchCalls).toBe(0);
  });

  test("uses the run-scoped tenant credential when explicitly enabled", async () => {
    let authorization = "";
    let recorded = false;
    await recordRunFollowups(
      {
        id: "run-2",
        threadId: "thread-2",
        orgId: "org-2",
        userId: "user-2",
        prompt: "Explain the change",
      },
      "A sufficiently long completed answer for suggestions.",
      {
        env: { FOLLOWUPS_ENABLED: "1" },
        resolveCredential: async (input) => {
          expect(input).toEqual({ orgId: "org-2", userId: "user-2", provider: "openrouter" });
          return { value: "tenant-key", source: "user_connection" };
        },
        fetch: (async (_url, init) => {
          authorization = new Headers(init?.headers).get("authorization") ?? "";
          return new Response(JSON.stringify({ choices: [{ message: { content: '["Next?"]' } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as typeof fetch,
        recordEvent: async () => {
          recorded = true;
        },
      },
    );

    expect(authorization).toBe("Bearer tenant-key");
    expect(recorded).toBe(true);
  });

  test("a member's key OpenRouter rejects is marked for reconnect; an outage is not", async () => {
    const marked: unknown[] = [];
    for (const status of [401, 500]) {
      await recordRunFollowups(
        { id: "run-3", threadId: "thread-3", orgId: "org-3", userId: "user-3", prompt: "Explain" },
        "A sufficiently long completed answer for suggestions.",
        {
          env: { FOLLOWUPS_ENABLED: "1" },
          resolveCredential: async () => ({ value: "member-key", source: "user_connection" }),
          fetch: (async () => new Response("upstream detail", { status })) as unknown as typeof fetch,
          markRejectedKey: async (input) => (marked.push(input), true),
          recordEvent: async () => undefined,
        },
      );
    }
    expect(marked).toEqual([
      { orgId: "org-3", userId: "user-3", provider: "openrouter", value: "member-key", status: 401 },
    ]);
  });
});
