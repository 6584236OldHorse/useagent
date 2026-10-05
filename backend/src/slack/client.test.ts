import { afterEach, describe, expect, test } from "bun:test";
import { httpSlackClient } from "./client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Slack streaming wire contract", () => {
  test("append and stop address the stream by Slack's required ts field", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ ok: true, ts: "1717171717.999999" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = httpSlackClient({ botToken: "xoxb-test", apiUrl: "https://slack.test/api/" });
    await client.appendStream({
      channel: "C123",
      threadTs: "1717171717.000001",
      messageTs: "1717171717.999999",
      chunks: [{ type: "markdown_text", text: "working" }],
    });
    await client.stopStream({
      channel: "C123",
      threadTs: "1717171717.000001",
      messageTs: "1717171717.999999",
      chunks: [{ type: "task_update", id: "run", title: "Done", status: "complete" }],
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual({
      url: "https://slack.test/api/chat.appendStream",
      body: {
        channel: "C123",
        thread_ts: "1717171717.000001",
        ts: "1717171717.999999",
        chunks: [{ type: "markdown_text", text: "working" }],
      },
    });
    expect(requests[1]).toEqual({
      url: "https://slack.test/api/chat.stopStream",
      body: {
        channel: "C123",
        thread_ts: "1717171717.000001",
        ts: "1717171717.999999",
        chunks: [{ type: "task_update", id: "run", title: "Done", status: "complete" }],
      },
    });
    expect(requests.some((request) => "message_ts" in request.body)).toBeFalse();
  });

  test("start sends a documented task_display_mode and the channel recipient identity", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true, ts: "1717171717.999999" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const client = httpSlackClient({ botToken: "xoxb-test", apiUrl: "https://slack.test/api/" });
    const result = await client.startStream({
      channel: "C123",
      threadTs: "1717171717.000001",
      taskDisplayMode: "timeline",
      chunks: [{ type: "task_update", id: "run", title: "Build", status: "in_progress" }],
      recipientTeamId: "T123",
      recipientUserId: "U123",
    });

    expect(result).toEqual({ ok: true, ts: "1717171717.999999" });
    expect(requests).toEqual([
      {
        url: "https://slack.test/api/chat.startStream",
        body: {
          channel: "C123",
          thread_ts: "1717171717.000001",
          task_display_mode: "timeline",
          chunks: [{ type: "task_update", id: "run", title: "Build", status: "in_progress" }],
          recipient_team_id: "T123",
          recipient_user_id: "U123",
        },
      },
    ]);
  });
});
