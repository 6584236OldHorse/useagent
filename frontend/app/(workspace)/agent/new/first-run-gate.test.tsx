import { expect, test } from "bun:test";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { firstRunApplies, settleLanding, watchLanding } from "@/lib/first-run";
import { FirstRunGate } from "./first-run-gate";
import { taskPrefilled } from "./task-prefill";

const router = {
  push() {},
  replace() {},
  refresh() {},
  back() {},
  forward() {},
  prefetch() {},
} as unknown as AppRouterInstance;

function render(initialDecision?: "pending" | "stay" | "open", prefilled = false) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <FirstRunGate initialDecision={initialDecision} prefilled={prefilled}>
        <textarea aria-label="Prompt" />
      </FirstRunGate>
    </AppRouterContext.Provider>,
  );
}

test("until the first-run check settles, nothing a person could type into is rendered", () => {
  const html = render();
  expect(html).toContain("Preparing your workspace");
  expect(html).not.toContain("<textarea");
  expect(render("open")).not.toContain("<textarea");
});

test("once the check says stay, the composer renders and the placeholder is gone", () => {
  const html = render("stay");
  expect(html).toContain("<textarea");
  expect(html).not.toContain("Preparing your workspace");
});

/** The parameters the page reads from /agent/new?prompt=Review%20PR%20278&repo=useagenthq/useagent-pro. */
const deepLink = { repo: "useagenthq/useagent-pro", prompt: "Review PR 278" };
const fresh = { id: "org-1", name: "Priya's workspace", role: "owner" as const, active: true, members: 1, defaultName: true };

test("a URL that carries a task goes straight to the composer, whatever the first-run check would say", () => {
  expect(taskPrefilled(deepLink)).toBe(true);
  expect(taskPrefilled({ repo: null, prompt: "Review PR 278" })).toBe(true);
  expect(taskPrefilled({ repo: "useagenthq/useagent-pro", prompt: "" })).toBe(true);
  const html = render(undefined, taskPrefilled(deepLink));
  expect(html).toContain("<textarea");
  expect(html).not.toContain("Preparing your workspace");
});

test("a plain /agent/new still waits for the check, and a first run still opens the page", async () => {
  expect(taskPrefilled({ repo: null, prompt: "" })).toBe(false);
  expect(taskPrefilled({ repo: "", prompt: "   " })).toBe(false);
  const html = render(undefined, taskPrefilled({ repo: null, prompt: "" }));
  expect(html).toContain("Preparing your workspace");
  expect(html).not.toContain("<textarea");
  const outcomes: string[] = [];
  watchLanding({ userId: "plain-landing", listWorkspaces: async () => [fresh], settle: (outcome) => outcomes.push(outcome) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(firstRunApplies(fresh)).toBe(true);
  expect(outcomes).toEqual(["open"]);
});

test("a task chosen while the check is pending settles the gate on the composer and the check's later answer is ignored", async () => {
  // The query changes, the component stays mounted: the decision moves from pending to stay...
  expect(settleLanding("pending", "stay")).toBe("stay");
  // ...and the watcher effect keyed on the decision runs its cleanup, so the answer in flight reports nothing.
  const outcomes: string[] = [];
  let answer: (() => void) | undefined;
  const cleanup = watchLanding({
    userId: "chooses-a-project",
    listWorkspaces: () => new Promise((resolve) => { answer = () => resolve([fresh]); }),
    settle: (outcome) => outcomes.push(outcome),
  });
  cleanup();
  answer?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(outcomes).toEqual([]);
  // A decision already settled is left alone: an opened page is not un-opened, a stay stays.
  expect(settleLanding("open", "stay")).toBe("open");
  expect(settleLanding("stay", "stay")).toBe("stay");
});
