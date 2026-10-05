import { describe, expect, test } from "bun:test";
import { chatTitle } from "./chat-title";

describe("chatTitle", () => {
  test("keeps the first sentence of the first line, without the ask-around", () => {
    expect(chatTitle("please add rate limiting to the gateway. I attached a screenshot.")).toBe(
      "Add rate limiting to the gateway",
    );
    expect(chatTitle("Hey, can you fix the login bug?")).toBe("Fix the login bug");
    expect(chatTitle("# Deploy to staging\n\nthen tag v2.4.0")).toBe("Deploy to staging");
    expect(chatTitle("`bun test` fails on main")).toBe("Bun test fails on main");
    expect(
      chatTitle("Nice. Now run the load test, open a PR, and attach the evidence."),
    ).toBe("Run the load test, open a PR, and attach the…");
  });

  test("cuts a long ask at a word boundary near 48 characters", () => {
    const title = chatTitle(
      "Add token-bucket rate limiting to the API gateway with 100 requests per minute per org",
    );
    expect(title).toBe("Add token-bucket rate limiting to the API…");
    expect(title.length).toBeLessThanOrEqual(49);
  });

  test("a short sentence is not cut and a version number is not a sentence end", () => {
    expect(chatTitle("Ship it.")).toBe("Ship it");
    expect(chatTitle("Bump to v1.2 and tag the release please")).toBe(
      "Bump to v1.2 and tag the release please",
    );
  });

  test("an empty or missing prompt reads New chat", () => {
    expect(chatTitle("")).toBe("New chat");
    expect(chatTitle(null)).toBe("New chat");
    expect(chatTitle("please")).toBe("New chat");
  });
});
