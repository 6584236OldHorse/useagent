import { describe, expect, test } from "bun:test";

import { labAccessAllowed } from "./access";

const production = { NODE_ENV: "production", USEAGENT_DEV_MODE: "false" } as const;

describe("labAccessAllowed", () => {
  test("development keeps the lab open to anyone", () => {
    expect(labAccessAllowed(null, { NODE_ENV: "development" })).toBe(true);
    expect(labAccessAllowed("member@example.com", { USEAGENT_DEV_MODE: "true" })).toBe(true);
  });

  test("production admits only the listed accounts, case and spacing aside", () => {
    const env = { ...production, LAB_ACCOUNTS: " Owner@Example.com, second@example.com " };
    expect(labAccessAllowed("owner@example.com", env)).toBe(true);
    expect(labAccessAllowed("SECOND@example.com", env)).toBe(true);
    expect(labAccessAllowed("member@example.com", env)).toBe(false);
    expect(labAccessAllowed("", env)).toBe(false);
    expect(labAccessAllowed(undefined, env)).toBe(false);
  });

  test("production with no list hides the lab from everyone", () => {
    expect(labAccessAllowed("owner@example.com", production)).toBe(false);
    expect(labAccessAllowed("owner@example.com", { ...production, LAB_ACCOUNTS: " , " })).toBe(false);
  });
});
