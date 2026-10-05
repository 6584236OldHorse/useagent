import { expect, test } from "bun:test";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { FirstRunGate } from "./first-run-gate";

const router = {
  push() {},
  replace() {},
  refresh() {},
  back() {},
  forward() {},
  prefetch() {},
} as unknown as AppRouterInstance;

function render(initialDecision?: "pending" | "stay" | "open") {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <FirstRunGate initialDecision={initialDecision}>
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
