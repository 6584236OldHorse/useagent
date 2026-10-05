import { expect, test } from "bun:test";
import { accountListed, accountOnList } from "./account-allowlist";

const development = { NODE_ENV: "development" };

test("a list names its accounts, case and spacing aside; unset or empty names nobody, development included", () => {
  const env = { ...development, OPERATOR_ACCOUNTS: " Owner@Example.com , ops@example.com " };
  expect(accountOnList("OPERATOR_ACCOUNTS", "owner@example.com", env)).toBe(true);
  expect(accountOnList("OPERATOR_ACCOUNTS", "someone@example.com", env)).toBe(false);
  expect(accountOnList("OPERATOR_ACCOUNTS", null, env)).toBe(false);
  expect(accountOnList("OPERATOR_ACCOUNTS", "owner@example.com", development)).toBe(false);
  expect(accountOnList("OPERATOR_ACCOUNTS", "owner@example.com", { ...development, OPERATOR_ACCOUNTS: "" })).toBe(false);
});

test("as an access gate the same list opens to everyone in development and only to its accounts in production", () => {
  expect(accountListed("OPERATOR_ACCOUNTS", null, development)).toBe(true);
  const production = { NODE_ENV: "production", OPERATOR_ACCOUNTS: "owner@example.com" };
  expect(accountListed("OPERATOR_ACCOUNTS", "Owner@example.com", production)).toBe(true);
  expect(accountListed("OPERATOR_ACCOUNTS", "someone@example.com", production)).toBe(false);
});
