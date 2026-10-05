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

import { watchFirstRun } from "./first-run";

function check(workspaces: Parameters<typeof firstRunApplies>[0][] = [fresh], userId = "landing-user") {
  const reported: boolean[] = [];
  let calls = 0;
  let answer: (() => void) | undefined;
  let fail: (() => void) | undefined;
  const cleanup = watchFirstRun({
    userId,
    listWorkspaces: () => {
      calls += 1;
      return new Promise((resolve, reject) => {
        answer = () => resolve(workspaces.filter((w): w is NonNullable<typeof w> => w !== undefined));
        fail = () => reject(new Error("workspaces 503"));
      });
    },
    settle: (firstRun) => reported.push(firstRun),
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    reported,
    cleanup,
    calls: () => calls,
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

test("the check reports a first run once the answer arrives, and nothing before it", async () => {
  const run = check();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(run.reported).toEqual([]);
  await run.answer();
  expect(run.reported).toEqual([true]);
});

test("a workspace that is not on a first run, a failed check and an unmount report no first run", async () => {
  const settled = check([{ ...fresh, members: 2 }]);
  await settled.answer();
  expect(settled.reported).toEqual([false]);

  const failed = check();
  await failed.fail();
  expect(failed.reported).toEqual([false]);

  const unmounted = check();
  unmounted.cleanup();
  await unmounted.answer();
  expect(unmounted.reported).toEqual([]);
});

test("a person who chose to continue is reported no first run without a request, and that persists", () => {
  markFirstRunSkipped("continued-user");
  const run = check([fresh], "continued-user");
  expect(run.reported).toEqual([false]);
  expect(run.calls()).toBe(0);
});
