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

import { watchLanding } from "./first-run";

function landing(workspaces: Parameters<typeof firstRunApplies>[0][] = [fresh]) {
  const opened: number[] = [];
  let answer: (() => void) | undefined;
  let typing: (() => void) | undefined;
  let unsubscribed = 0;
  const cleanup = watchLanding({
    userId: "landing-user",
    listWorkspaces: () =>
      new Promise((resolve) => {
        answer = () => resolve(workspaces.filter((w): w is NonNullable<typeof w> => w !== undefined));
      }),
    onInput: (handler) => {
      typing = handler;
      return () => {
        unsubscribed += 1;
      };
    },
    open: () => opened.push(Date.now()),
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    opened,
    cleanup,
    answer: async () => {
      answer?.();
      await settle();
    },
    type: () => typing?.(),
    unsubscribedTimes: () => unsubscribed,
  };
}

test("landing: the first-run page opens when the check answers before any typing", async () => {
  const run = landing();
  await run.answer();
  expect(run.opened).toHaveLength(1);
  run.cleanup();
  expect(run.unsubscribedTimes()).toBe(1);
});

test("landing: typing before the answer keeps the composer; the draft is never unmounted", async () => {
  const run = landing();
  run.type();
  await run.answer();
  expect(run.opened).toHaveLength(0);
});

test("landing: an unmount before the answer, or a workspace that is not on a first run, opens nothing", async () => {
  const unmounted = landing();
  unmounted.cleanup();
  await unmounted.answer();
  expect(unmounted.opened).toHaveLength(0);

  const settled = landing([{ ...fresh, members: 2 }]);
  await settled.answer();
  expect(settled.opened).toHaveLength(0);
});
