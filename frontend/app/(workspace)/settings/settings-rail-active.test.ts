import { describe, expect, test } from "bun:test";
import {
  activeSectionIndex,
  SETTINGS_ACTIVATION_RATIO,
  SETTINGS_SCROLL_TAIL_RATIO,
  settingsAnchorOffset,
} from "./settings-rail-active";

// The settings page measured on production at 1440x900: section top edges at
// rest inside the shell's <main> scroller (3822px of content before the
// trailing scroll reserve, 900px viewport). Rail order: general, providers,
// integrations, usage, infrastructure, secrets, apikeys, team.
const TOPS_AT_REST = [92, 411, 1550, 1950, 2369, 3043, 3319, 3638] as const;
const VIEWPORT_HEIGHT = 900;
const CONTENT_HEIGHT = 3822;
const SCROLL_HEIGHT = CONTENT_HEIGHT + VIEWPORT_HEIGHT * SETTINGS_SCROLL_TAIL_RATIO;
const MAX_SCROLL_TOP = SCROLL_HEIGHT - VIEWPORT_HEIGHT;
const ANCHOR_SCROLL_MARGIN = VIEWPORT_HEIGHT * SETTINGS_ACTIVATION_RATIO;

const INFRASTRUCTURE = 4;
const SECRETS = 5;
const API_KEYS = 6;
const TEAM = 7;

const scrolledTo = (scrollTop: number) => ({
  sectionTops: TOPS_AT_REST.map((top) => top - scrollTop),
  viewportHeight: VIEWPORT_HEIGHT,
});

const anchoredTo = (index: number) =>
  scrolledTo(Math.min(TOPS_AT_REST[index] - ANCHOR_SCROLL_MARGIN, MAX_SCROLL_TOP));

describe("settings rail scroll-spy", () => {
  test("the final section crosses the normal activation line at the real scroll boundary", () => {
    expect(activeSectionIndex(scrolledTo(MAX_SCROLL_TOP))).toBe(TEAM);
  });

  test("anchor navigation keeps each final section independently reachable and highlighted", () => {
    expect(activeSectionIndex(anchoredTo(SECRETS))).toBe(SECRETS);
    expect(activeSectionIndex(anchoredTo(API_KEYS))).toBe(API_KEYS);
    expect(activeSectionIndex(anchoredTo(TEAM))).toBe(TEAM);
  });

  test("a compact next card cannot steal the anchored section at the activation line", () => {
    const line = VIEWPORT_HEIGHT * SETTINGS_ACTIVATION_RATIO;
    expect(
      activeSectionIndex({ sectionTops: [line, line + 170], viewportHeight: VIEWPORT_HEIGHT }),
    ).toBe(0);
  });

  test("reproduces the collapsed boundary that made API keys impossible to select", () => {
    const oldMaxScrollTop = CONTENT_HEIGHT - VIEWPORT_HEIGHT;
    const apiKeysScrollTop = Math.min(
      TOPS_AT_REST[API_KEYS] - ANCHOR_SCROLL_MARGIN,
      oldMaxScrollTop,
    );
    const teamScrollTop = Math.min(TOPS_AT_REST[TEAM] - ANCHOR_SCROLL_MARGIN, oldMaxScrollTop);
    expect(apiKeysScrollTop).toBe(teamScrollTop);
    expect(activeSectionIndex(scrolledTo(oldMaxScrollTop))).toBe(SECRETS);
  });

  test("mid-page a section takes over once its top reaches the upper 30% band", () => {
    const secretsOnTheLine = TOPS_AT_REST[SECRETS] - VIEWPORT_HEIGHT * 0.3;
    expect(activeSectionIndex(scrolledTo(secretsOnTheLine))).toBe(SECRETS);
    expect(activeSectionIndex(scrolledTo(secretsOnTheLine - 2))).toBe(INFRASTRUCTURE);
  });

  test("anchor offset uses the scroll root height instead of the outer viewport", () => {
    // Electron at 960px high: the title bar and shell leave a 916px <main>.
    const outerViewportHeight = 960;
    const scrollRootHeight = 916;
    const oldOuterViewportMargin = outerViewportHeight * SETTINGS_ACTIVATION_RATIO;
    const anchoredWith = (margin: number) =>
      activeSectionIndex({
        sectionTops: TOPS_AT_REST.map((top) => top - (TOPS_AT_REST[INFRASTRUCTURE] - margin)),
        viewportHeight: scrollRootHeight,
      });

    expect(anchoredWith(oldOuterViewportMargin)).toBe(3);
    expect(anchoredWith(settingsAnchorOffset(scrollRootHeight))).toBe(INFRASTRUCTURE);
  });

  test("subpixel anchor rounding does not revert the clicked section", () => {
    const line = settingsAnchorOffset(916);
    expect(
      activeSectionIndex({
        sectionTops: [-300, -10, line - 20, line - 5, line + 0.09375, line + 400],
        viewportHeight: 916,
      }),
    ).toBe(INFRASTRUCTURE);
  });

  test("the first section is active at rest and whenever nothing has crossed the line", () => {
    expect(activeSectionIndex(scrolledTo(0))).toBe(0);
    expect(
      activeSectionIndex({
        sectionTops: [400, 732],
        viewportHeight: VIEWPORT_HEIGHT,
      }),
    ).toBe(0);
  });
});
