import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FineTuneCard } from "./fine-tune-card";

test("the Type control renders the shared Select with its placeholder", () => {
  const html = renderToStaticMarkup(<FineTuneCard />);
  expect(html).toContain('aria-label="Type"');
  expect(html).toContain('aria-haspopup="listbox"');
  expect(html).toContain("Select type");
});
