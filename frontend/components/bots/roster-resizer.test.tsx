import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ROSTER_MAX,
  ROSTER_MIN,
  RosterResizer,
  rosterLayoutFor,
  rosterWidthForKey,
  rosterWidthFromPointer,
} from "./roster-resizer";

describe("bots roster resizing", () => {
  test("targets room for the thread and restores a preferred width after a narrow viewport", () => {
    expect(rosterLayoutFor({ preferredWidth: 560, containerWidth: 760 })).toEqual({
      width: 280,
      maximum: 280,
    });
    expect(rosterLayoutFor({ preferredWidth: 560, containerWidth: 1200 })).toEqual({
      width: 560,
      maximum: ROSTER_MAX,
    });
  });

  test("maps pointer and arrow movement to the panel edge in both directions", () => {
    expect(
      rosterWidthFromPointer({
        panelLeft: 200,
        panelRight: 520,
        containerWidth: 1200,
        pointerX: 560,
        direction: "ltr",
      }),
    ).toBe(360);
    expect(
      rosterWidthFromPointer({
        panelLeft: 680,
        panelRight: 1000,
        containerWidth: 1200,
        pointerX: 640,
        direction: "rtl",
      }),
    ).toBe(360);
    expect(rosterWidthForKey({ key: "ArrowRight", current: 320, containerWidth: 1200 })).toBe(336);
    expect(
      rosterWidthForKey({ key: "ArrowLeft", current: 320, containerWidth: 1200, direction: "rtl" }),
    ).toBe(336);
  });

  test("renders a desktop-only, keyboard-reachable separator with its current bounds", () => {
    const html = renderToStaticMarkup(
      <RosterResizer
        value={320}
        maximum={420}
        onMove={() => {}}
        onCommit={() => {}}
        onKeyDown={() => {}}
        onReset={() => {}}
      />,
    );

    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain(`aria-valuemin="${ROSTER_MIN}"`);
    expect(html).toContain('aria-valuemax="420"');
    expect(html).toContain('aria-valuenow="320"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain("hidden");
    expect(html).toContain("md:block");
  });
});
