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

  test("the thread status carries the calm phrases as loading_messages; a clear sends none", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const client = httpSlackClient({ botToken: "xoxb-test", apiUrl: "https://slack.test/api/" });
    await client.setThreadStatus({ channel: "C123", threadTs: "1.1", status: "Working on it", loadingMessages: ["Working on it", "Nearly there"] });
    await client.setThreadStatus({ channel: "C123", threadTs: "1.1", status: "", loadingMessages: ["Working on it"] });
    expect(requests.map((r) => r.url)).toEqual([
      "https://slack.test/api/assistant.threads.setStatus",
      "https://slack.test/api/assistant.threads.setStatus",
    ]);
    expect(requests[0]!.body).toEqual({
      channel_id: "C123",
      thread_ts: "1.1",
      status: "Working on it",
      loading_messages: ["Working on it", "Nearly there"],
    });
    expect(requests[1]!.body).toEqual({ channel_id: "C123", thread_ts: "1.1", status: "" });
  });

  test("a bare stop and an empty blocks array send neither field", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const client = httpSlackClient({ botToken: "xoxb-test", apiUrl: "https://slack.test/api/" });
    await client.stopStream({ channel: "C123", threadTs: "1.1", messageTs: "1.2", chunks: [], blocks: [] });
    await client.postMessage({ channel: "C123", text: "hi", threadTs: "1.1", blocks: [] });
    expect(requests[0]!.body).toEqual({ channel: "C123", thread_ts: "1.1", ts: "1.2" });
    expect("blocks" in requests[1]!.body).toBe(false);
  });

  test("a deleted message is a permanent failure, so a card revision posts fresh instead of retrying", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: false, error: "message_not_found" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const client = httpSlackClient({ botToken: "xoxb-test", apiUrl: "https://slack.test/api/" });
    expect(await client.updateMessage({ channel: "C123", ts: "1.1", text: "t" })).toEqual({
      ok: false,
      class: "permanent",
      message: "message_not_found",
    });
  });

  test("a member is named by the display name they chose, then the full name, then the handle", async () => {
    let user: Record<string, unknown> = { real_name: "Alex Legal", name: "alegal", profile: { display_name: "Lex" } };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true, user }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const client = httpSlackClient({ botToken: "xoxb-test", apiUrl: "https://slack.test/api/" });
    expect((await client.userInfo!({ user: "U1" }))?.name).toBe("Lex");
    user = { real_name: "Alex Legal", name: "alegal", profile: { display_name: "  " } };
    expect((await client.userInfo!({ user: "U1" }))?.name).toBe("Alex Legal");
    user = { name: "alegal", profile: {} };
    expect((await client.userInfo!({ user: "U1" }))?.name).toBe("alegal");
  });
});
