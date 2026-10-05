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
const deepLink = { repo: "useagenthq/useagent-pro", prompt: "Review PR 278", skill: null };
const fresh = { id: "org-1", name: "Priya's workspace", role: "owner" as const, active: true, members: 1, defaultName: true };

test("a URL that carries a task goes straight to the composer, whatever the first-run check would say", () => {
  expect(taskPrefilled(deepLink)).toBe(true);
  expect(taskPrefilled({ repo: null, prompt: "Review PR 278", skill: null })).toBe(true);
  expect(taskPrefilled({ repo: "useagenthq/useagent-pro", prompt: "", skill: null })).toBe(true);
  expect(taskPrefilled({ repo: null, prompt: "", skill: "skill_release_notes" })).toBe(true);
  const html = render(undefined, taskPrefilled(deepLink));
  expect(html).toContain("<textarea");
  expect(html).not.toContain("Preparing your workspace");
});

test("a plain /agent/new still waits for the check, and a first run still opens the page", async () => {
  expect(taskPrefilled({ repo: null, prompt: "", skill: null })).toBe(false);
  expect(taskPrefilled({ repo: "", prompt: "   ", skill: "" })).toBe(false);
  const html = render(undefined, taskPrefilled({ repo: null, prompt: "", skill: null }));
  expect(html).toContain("Preparing your workspace");
  expect(html).not.toContain("<textarea");
  const outcomes: string[] = [];
  watchLanding({ userId: "plain-landing", listWorkspaces: async () => [fresh], settle: (outcome) => outcomes.push(outcome), stillHere: () => true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(firstRunApplies(fresh)).toBe(true);
  expect(outcomes).toEqual(["open"]);
});

test("a New thread requested while the check is pending, its page still on its way, is never superseded by /welcome", async () => {
  // Plain /agent/new as a first-run owner: the check is in flight.
  const outcomes: string[] = [];
  let answer: (() => void) | undefined;
  const page = { location: "/agent/new", navigationRequested: false };
  const startedAt = page.location;
  watchLanding({
    userId: "chooses-a-project",
    listWorkspaces: () => new Promise((resolve) => { answer = () => resolve([fresh]); }),
    settle: (outcome) => outcomes.push(outcome),
    // What the gate answers: nothing requested from the page and the URL it started for.
    stillHere: () => !page.navigationRequested && page.location === startedAt,
  });
  // The person picks a project's "New thread": the capture-phase listener runs
  // before the handler that calls the router, and the new page's response is
  // delayed, so the URL has not changed yet.
  page.navigationRequested = true;
  expect(settleLanding("pending", "stay")).toBe("stay");
  // The old check answers with a first-run workspace...
  answer?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  // ...and settles on the composer, never on /welcome: the repository navigation stands.
  expect(outcomes).toEqual(["stay"]);
  expect(firstRunApplies(fresh)).toBe(true);
});

test("an answer that arrives after the URL has already changed settles on the composer too", async () => {
  const outcomes: string[] = [];
  let answer: (() => void) | undefined;
  const page = { location: "/agent/new" };
  const startedAt = page.location;
  watchLanding({
    userId: "moved-on",
    listWorkspaces: () => new Promise((resolve) => { answer = () => resolve([fresh]); }),
    settle: (outcome) => outcomes.push(outcome),
    stillHere: () => page.location === startedAt,
  });
  page.location = "/agent/new?repo=useagenthq%2Fuseagent-pro";
  answer?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(outcomes).toEqual(["stay"]);
  // A decision already settled is left alone: an opened page is not un-opened, a stay stays.
  expect(settleLanding("open", "stay")).toBe("open");
  expect(settleLanding("stay", "stay")).toBe("stay");
});
