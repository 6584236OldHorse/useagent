import { describe, expect, test } from "bun:test";
import { chatTurnCredential, chatFailure } from "./turn";

describe("chat turn credential", () => {
  test("a stopped run does not wait on a blocked credential read", async () => {
    const stopped = new AbortController();
    stopped.abort(new Error("Stopped by user"));
    await expect(
      chatTurnCredential({ orgId: "org-a", userId: "user-a" }, stopped.signal, {
        resolve: () => new Promise(() => {}),
      }),
    ).rejects.toThrow("Stopped by user");
  });

  test("a member without a key is told to connect one, and the failure names it", async () => {
    const attempt = chatTurnCredential({ orgId: "org-a", userId: "user-a" }, new AbortController().signal, {
      resolve: async () => null,
    });
    await expect(attempt).rejects.toThrow("Connect an OpenRouter key in Settings");
    const failure = chatFailure(await attempt.catch((error) => error));
    expect(failure).toEqual({
      label: "OpenRouter key needed",
      reason:
        "Chat cannot start: no OpenRouter key is connected for this organization. " +
        "Connect an OpenRouter key in Settings, then retry.",
    });
  });
});
