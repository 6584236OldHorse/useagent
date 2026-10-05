import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeBlock } from "./code-block";

/** Before the highlighter runs (server render, streaming, or the settle window)
 * the block shows the real code as plain numbered lines, with no per-line
 * entrance animation to hide it. */
test("code renders plain and readable before highlighting, without a per-line entrance", () => {
  const html = renderToStaticMarkup(<CodeBlock code={"const a = 1;\nconst b = 2;\n"} language="ts" />);
  expect(html).toContain("const a = 1;");
  expect(html).toContain("const b = 2;");
  expect(html).not.toContain("ai-code-line");
  expect(html).not.toContain("animation-delay");
  expect(html.match(/class="line"/g)?.length).toBe(2);
});

test("a streaming block keeps its caret and stays plain", () => {
  const html = renderToStaticMarkup(<CodeBlock code="print(1)" language="py" streaming />);
  expect(html).toContain("print(1)");
  expect(html).toContain("ai-caret");
  expect(html).not.toContain("shiki");
});

test("an empty block shows the empty label instead of a body", () => {
  const html = renderToStaticMarkup(<CodeBlock code="" emptyLabel="Nothing captured." />);
  expect(html).toContain("Nothing captured.");
  expect(html).not.toContain('class="line"');
});
