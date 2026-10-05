import { expect, test } from "bun:test";
import { __sandboxMinutesTest } from "./sandbox-minutes";

const { operatorAccount } = __sandboxMinutesTest;
const emailOf = async (id: string) => (id === "u-owner" ? "Owner@Example.com" : "someone@example.com");

test("an operator account is exempt from the sandbox minutes cap; nobody else is", async () => {
  const env = { OPERATOR_ACCOUNTS: " owner@example.com , ops@example.com " };
  expect(await operatorAccount("u-owner", env, emailOf)).toBe(true);
  expect(await operatorAccount("u-other", env, emailOf)).toBe(false);
  expect(await operatorAccount("u-owner", {}, emailOf)).toBe(false);
  expect(await operatorAccount("u-owner", { OPERATOR_ACCOUNTS: "" }, emailOf)).toBe(false);
});
