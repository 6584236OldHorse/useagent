import { expect, test } from "bun:test";
import { connectionChanged } from "./use-codex-chatgpt-connection";

test("the first status read is a baseline, not a change", () => {
  expect(connectionChanged(undefined, "chatgpt")).toBe(false);
  expect(connectionChanged(undefined, null)).toBe(false);
});

test("a login completing or an account going away is a change", () => {
  expect(connectionChanged(null, "chatgpt")).toBe(true);
  expect(connectionChanged("chatgpt", null)).toBe(true);
  expect(connectionChanged("api_key", "chatgpt")).toBe(true);
});

test("reading the same connected account again is not a change", () => {
  expect(connectionChanged("chatgpt", "chatgpt")).toBe(false);
});
