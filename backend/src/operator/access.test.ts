import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { AppEnv } from "../http";
import { operatorAccessAllowed, operatorOnly } from "./access";

const production = { NODE_ENV: "production", USEAGENT_DEV_MODE: "false" } as const;

describe("operatorAccessAllowed", () => {
  test("development keeps the operator surfaces open to anyone", () => {
    expect(operatorAccessAllowed(null, { NODE_ENV: "development" })).toBe(true);
  });

  test("production admits only the listed accounts, case and spacing aside", () => {
    const env = { ...production, OPERATOR_ACCOUNTS: " Owner@Example.com ,second@example.com" };
    expect(operatorAccessAllowed("owner@example.com", env)).toBe(true);
    expect(operatorAccessAllowed("SECOND@example.com", env)).toBe(true);
    expect(operatorAccessAllowed("member@example.com", env)).toBe(false);
    expect(operatorAccessAllowed(undefined, env)).toBe(false);
  });

  test("production with no list admits nobody, and the lab's list does not count", () => {
    expect(operatorAccessAllowed("owner@example.com", production)).toBe(false);
    expect(operatorAccessAllowed("owner@example.com", { ...production, LAB_ACCOUNTS: "owner@example.com" })).toBe(false);
  });
});

describe("operatorOnly", () => {
  const original = { mode: process.env.USEAGENT_DEV_MODE, list: process.env.OPERATOR_ACCOUNTS };
  afterEach(() => {
    for (const [name, value] of [["USEAGENT_DEV_MODE", original.mode], ["OPERATOR_ACCOUNTS", original.list]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  const app = new Hono<AppEnv>();
  app.use("*", operatorOnly);
  app.get("/vendor", (c) => c.json({ label: "Cube" }));

  test("a request that is not an operator's gets the 404 of a route that does not exist", async () => {
    process.env.USEAGENT_DEV_MODE = "false";
    process.env.OPERATOR_ACCOUNTS = "owner@example.com";
    // No session behind the request (an API key, the dev identity): never an operator.
    const response = await app.request("/vendor");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Cube");
  });

  test("development passes through", async () => {
    process.env.USEAGENT_DEV_MODE = "true";
    expect((await app.request("/vendor")).status).toBe(200);
  });
});
