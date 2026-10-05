import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { FirstRunNotice } from "./first-run-notice";

test("the card appears on a first-run workspace and not otherwise, and the composer is never behind it", () => {
  const shown = renderToStaticMarkup(
    <>
      <FirstRunNotice initialFirstRun />
      <textarea aria-label="Prompt" />
    </>,
  );
  expect(shown).toContain("Your workspace is not set up yet.");
  expect(shown).toContain('href="/welcome"');
  expect(shown).toContain("Set up your workspace");
  expect(shown).toContain("Continue");
  expect(shown).toContain("<textarea");
  // Before the check answers (the page's real initial state) there is no card and the composer is there.
  const pending = renderToStaticMarkup(
    <>
      <FirstRunNotice />
      <textarea aria-label="Prompt" />
    </>,
  );
  expect(pending).not.toContain("Your workspace is not set up yet.");
  expect(pending).toContain("<textarea");
  expect(renderToStaticMarkup(<FirstRunNotice initialFirstRun={false} />)).toBe("");
});

test("no navigation originates from the notice: a plain link, no router", () => {
  const source = readFileSync(join(import.meta.dir, "first-run-notice.tsx"), "utf8");
  expect(source).not.toMatch(/useRouter|router\.(push|replace)|window\.location|redirect\(/);
  expect(source).toContain('href="/welcome"');
});
