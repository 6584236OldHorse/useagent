import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseSandboxMinutes, SandboxMinutesRow, sandboxMinutesCapped, sandboxMinutesLabel } from "./sandbox-minutes-row";

test("renders the row with its loading label before the figure arrives, without em dashes", () => {
  const html = renderToStaticMarkup(createElement(SandboxMinutesRow));
  expect(html).toContain("Sandbox minutes");
  expect(html).toContain("Loading...");
  expect(html).not.toContain("—");
});

test("parses the backend shape and labels the figure against the cap", () => {
  expect(parseSandboxMinutes({ used: 12, cap: 600, runs: 3 })).toEqual({ used: 12, cap: 600 });
  expect(parseSandboxMinutes({ used: 4, cap: null })).toEqual({ used: 4, cap: null });
  expect(parseSandboxMinutes({ cap: 600 })).toBeNull();
  expect(sandboxMinutesLabel({ used: 12, cap: 600 })).toBe("Used 12 of 600 minutes");
  expect(sandboxMinutesLabel({ used: 1, cap: null })).toBe("Used 1 minute");
  expect(sandboxMinutesLabel({ used: 4, cap: null })).toBe("Used 4 minutes");
  expect(sandboxMinutesCapped({ used: 600, cap: 600 })).toBe(true);
  expect(sandboxMinutesCapped({ used: 599, cap: 600 })).toBe(false);
  expect(sandboxMinutesCapped({ used: 5000, cap: null })).toBe(false);
});
