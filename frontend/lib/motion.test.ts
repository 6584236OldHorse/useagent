import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { EASE_OUT } from "./motion";

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/** One easing curve for UI motion, in CSS and in motion/react, and the motion
 *  rules the design skills hold us to (reduced motion honoured, keyboard-free
 *  chrome not animating linearly, the answer fade under 300 ms). */
describe("motion alignment", () => {
  test("the CSS token and the shared constant are the same four numbers", async () => {
    const theme = await read("styles/theme.css");
    expect(theme).toContain(`--ease-out: cubic-bezier(${EASE_OUT.join(", ")});`);
  });

  test("no component redeclares the curve locally", async () => {
    for (const path of [
      "components/pro/agent-limits-card.tsx",
      "components/shared/number-ticker.tsx",
      "components/application/charts/bar-list-card.tsx",
      "components/fleet/limits-row.tsx",
      "components/application/agent-limits/agent-limits-card.tsx",
    ]) {
      const source = await read(path);
      expect(source).toContain('import { EASE_OUT } from "@/lib/motion";');
      expect(source).not.toContain("[0.22, 1, 0.36, 1]");
    }
  });

  test("every motion/react animation honours the reduced-motion setting", async () => {
    const providers = await read("app/providers.tsx");
    expect(providers).toContain('<MotionConfig reducedMotion="user">');
  });

  test("the answer fade is under 300 ms and on the shared curve", async () => {
    const css = await read("app/globals.css");
    expect(css).toContain("animation: ai-fade-up 220ms var(--ease-out) both;");
    expect(css).not.toContain("ai-fade-up 350ms");
  });

  test("the sidebar collapse does not ease linearly and the table does not animate its type size", async () => {
    const sidebar = await read("components/sidebar-kit/sidebar.tsx");
    expect(sidebar).not.toContain("transition-[width] duration-200 ease-linear");
    expect(sidebar).not.toContain("transition-[left,right,width] duration-200 ease-linear");
    const css = await read("app/globals.css");
    expect(css).not.toContain("font-size 200ms ease");
  });

  test("tooltips wait before the first show, scale from their side and stay in the subtle range", async () => {
    const tooltip = await read("components/base/tooltip/tooltip.tsx");
    expect(tooltip).toContain("export const TOOLTIP_DELAY_MS = 500;");
    expect(tooltip).toContain("delay = TOOLTIP_DELAY_MS");
    expect(tooltip).toContain("data-[placement=top]:origin-bottom data-[placement=bottom]:origin-top");
    expect(tooltip).not.toContain("scale-90");
  });
  test("the composer's four most-used controls give press feedback", async () => {
    for (const [path, marker] of [
      ["components/chat/composer.tsx", '"button-press-motion flex shrink-0 items-center justify-center overflow-hidden rounded-full"'],
      ["components/pro/composer-panel/composer-panel.tsx", '"button-press-motion flex size-9 shrink-0'],
      ["components/pro/composer-panel/composer-panel.tsx", '"button-press-motion flex h-8 shrink-0'],
      ["components/pro/composer-status-bar.tsx", 'className="button-press-motion flex items-center gap-1 rounded-[40px]'],
    ]) {
      expect(await read(path)).toContain(marker);
    }
  });

  test("a keyboard toggle of the sidebar lands without the width transition", async () => {
    const sidebar = await read("components/sidebar-kit/sidebar.tsx");
    expect(sidebar).toContain("group-data-[instant]/sidebar-wrapper:transition-none");
    expect(sidebar).toContain('data-instant={instant ? "" : undefined}');
    // The shortcut handler marks the toggle instant before it toggles.
    expect(sidebar).toMatch(/event\.preventDefault\(\);\s*setInstant\(true\);\s*toggleSidebar\(\);/);
  });

  test("a keyboard-opened command palette skips the enter and exit animation", async () => {
    const search = await read("components/shell/search-command.tsx");
    expect(search).toMatch(/event\.preventDefault\(\);\s*setInstant\(true\);\s*setOpen\(\(prev\) => !prev\);/);
    expect(search).toMatch(/setInstant\(false\);\s*handleOpenChange\(true\);/);
    expect(search).toContain("instant={instant}");
    const modal = await read("components/base/modal/modal.tsx");
    expect(modal).toContain('const INSTANT_ANIMATION: React.CSSProperties = { animationDuration: "0s" };');
    expect(modal).toContain("<ModalOverlay className={overlayClassName} style={instantStyle}>");
  });
});
