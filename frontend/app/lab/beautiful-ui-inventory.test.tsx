import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import manifest from "@/vendor/beautiful-ui/manifest.json";
import { BeautifulUiExtras } from "./beautiful-ui-extras";
import { BEAUTIFUL_UI_COMPONENTS } from "./beautiful-ui-inventory";

describe("Beautiful UI lab inventory", () => {
  test("exposes every vendored component exactly once", () => {
    const manifestSlugs = manifest.components.map(({ slug }) => slug).toSorted();
    const labSlugs: string[] = [...BEAUTIFUL_UI_COMPONENTS].toSorted();

    expect(labSlugs).toHaveLength(21);
    expect(new Set(labSlugs).size).toBe(21);
    expect(labSlugs).toEqual(manifestSlugs);
  });

  test("mounts the Flowchart demo in the existing lab collection", () => {
    const html = renderToStaticMarkup(<BeautifulUiExtras />);
    expect(html.match(/data-beautiful-ui-component="flowchart"/g)).toHaveLength(1);
    expect(html).toContain("New order created");
    expect(html).toContain("If condition field");
  });
});
