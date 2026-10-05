import { describe, expect, test } from "bun:test";
import { replyRunBody } from "./reply-run-body";

describe("replyRunBody", () => {
  test("sends only what is set; bot mentions and a command ride with their provider context", () => {
    const base = {
      text: "Do it",
      engine: "opencode" as const,
      model: null,
      parentRunId: "run-1",
      memoryScope: "org" as const,
      attachmentIds: [],
      resources: [],
      botMentions: [],
      engineSessionId: null,
      commandCatalogRevision: null,
    };
    expect(replyRunBody(base)).toEqual({ prompt: "Do it", engine: "opencode", parent_run_id: "run-1", memory_scope: "org" });
    expect(replyRunBody({ ...base, permissionMode: "read-only" })).toEqual({
      prompt: "Do it",
      engine: "opencode",
      parent_run_id: "run-1",
      memory_scope: "org",
      permission_mode: "read-only",
    });
    // A reasoning effort rides only when the picker chose one; null inherits the thread's.
    expect(replyRunBody({ ...base, reasoningEffort: null })).not.toHaveProperty("reasoning_effort");
    expect(replyRunBody({ ...base, reasoningEffort: "xhigh" })).toMatchObject({ reasoning_effort: "xhigh" });

    expect(
      replyRunBody({
        ...base,
        model: "claude-sonnet-5",
        attachmentIds: ["up-1"],
        botMentions: ["bot-1", "bot-2"],
        command: { name: "review", args: "--all" },
        engineSessionId: "sess-9",
        commandCatalogRevision: "rev-3",
      }),
    ).toEqual({
      prompt: "Do it",
      engine: "opencode",
      model: "claude-sonnet-5",
      parent_run_id: "run-1",
      memory_scope: "org",
      attachments: ["up-1"],
      bot_mentions: ["bot-1", "bot-2"],
      command: { name: "review", args: "--all", provider: "opencode", sessionId: "sess-9", catalogRevision: "rev-3" },
    });
  });
});
