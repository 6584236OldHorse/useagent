import { afterEach, expect, test } from "bun:test";
import { firstRunApplies, firstRunSkipped, markFirstRunSkipped } from "./first-run";

const fresh = {
  id: "org-1",
  name: "Priya's workspace",
  role: "owner" as const,
  active: true,
  members: 1,
  defaultName: true,
};

test("first run: the workspace still carries its default name and its creator is the only member", () => {
  expect(firstRunApplies(fresh)).toBe(true);
  expect(firstRunApplies({ ...fresh, defaultName: false })).toBe(false); // renamed
  expect(firstRunApplies({ ...fresh, members: 2 })).toBe(false); // someone joined
  expect(firstRunApplies({ ...fresh, role: "admin" })).toBe(false); // not the creator
  expect(firstRunApplies(undefined)).toBe(false);
});

const globals = globalThis as { window?: unknown };
afterEach(() => {
  delete globals.window;
});

test("skipping is remembered per person: in this browser when it stores, for this page either way", () => {
  // No storage at all: the choice still holds for the page, so Continue cannot bounce back.
  expect(firstRunSkipped("u1")).toBe(false);
  expect(() => markFirstRunSkipped("u1")).not.toThrow();
  expect(firstRunSkipped("u1")).toBe(true);

  const store = new Map<string, string>();
  globals.window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  };
  expect(firstRunSkipped("u2")).toBe(false);
  markFirstRunSkipped("u2");
  expect(store.get("first-run-skipped:u2")).toBeDefined();
  expect(firstRunSkipped("u3")).toBe(false);
  // Another page load in the same browser reads it back from storage.
  store.set("first-run-skipped:u3", "2026-09-13T10:00:00.000Z");
  expect(firstRunSkipped("u3")).toBe(true);
});
