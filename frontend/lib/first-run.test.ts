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

import { settleLanding, watchLanding } from "./first-run";

function landing(workspaces: Parameters<typeof firstRunApplies>[0][] = [fresh], userId = "landing-user") {
  const outcomes: string[] = [];
  let answer: (() => void) | undefined;
  let fail: (() => void) | undefined;
  const cleanup = watchLanding({
    userId,
    listWorkspaces: () =>
      new Promise((resolve, reject) => {
        answer = () => resolve(workspaces.filter((w): w is NonNullable<typeof w> => w !== undefined));
        fail = () => reject(new Error("workspaces 503"));
      }),
    settle: (outcome) => outcomes.push(outcome),
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    outcomes,
    cleanup,
    answer: async () => {
      answer?.();
      await settle();
    },
    fail: async () => {
      fail?.();
      await settle();
    },
  };
}

test("landing: nothing settles before the check answers, so no composer is enabled meanwhile", async () => {
  const run = landing();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(run.outcomes).toEqual([]);
  run.cleanup();
});

test("landing: a first run opens the page from the pending state; anything else stays, exactly once", async () => {
  const open = landing();
  await open.answer();
  expect(open.outcomes).toEqual(["open"]);

  const stay = landing([{ ...fresh, members: 2 }]);
  await stay.answer();
  expect(stay.outcomes).toEqual(["stay"]);

  const failed = landing();
  await failed.fail();
  expect(failed.outcomes).toEqual(["stay"]);

  const unmounted = landing();
  unmounted.cleanup();
  await unmounted.answer();
  expect(unmounted.outcomes).toEqual([]);
});

test("landing: a person who chose to continue before stays without a request", () => {
  markFirstRunSkipped("skipped-user");
  const run = landing([fresh], "skipped-user");
  expect(run.outcomes).toEqual(["stay"]);
});

test("landing: once the composer is up, no later outcome navigates away from it", () => {
  expect(settleLanding("pending", "open")).toBe("open");
  expect(settleLanding("pending", "stay")).toBe("stay");
  expect(settleLanding("stay", "open")).toBe("stay");
  expect(settleLanding("open", "stay")).toBe("open");
});
