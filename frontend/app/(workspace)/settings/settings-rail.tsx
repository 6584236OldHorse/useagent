"use client";

import { useEffect, useState } from "react";
import { useOperatorAccess } from "@/lib/account-access";
import { cx } from "@/utils/cx";
import { activeSectionIndex, settingsAnchorOffset } from "./settings-rail-active";

/**
 * Sticky left section rail for the settings page. Anchor links jump to each
 * section; a scroll-spy measures the section top edges against the scroll
 * container on every scroll and layout change and keeps the matching link
 * marked active. The selection rule lives in settings-rail-active.ts.
 */

export const SETTINGS_SECTIONS = [
  { id: "general", label: "General" },
  { id: "providers", label: "Providers" },
  { id: "integrations", label: "Integrations" },
  { id: "usage", label: "Usage" },
  { id: "infrastructure", label: "Infrastructure" },
  { id: "machines", label: "Machines" },
  { id: "secrets", label: "Secrets" },
  { id: "apikeys", label: "API keys" },
  { id: "team", label: "Team" },
] as const;

/** Nearest scrolling ancestor, or null when the window itself scrolls. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

export function SettingsRail({ className }: { className?: string }) {
  const [active, setActive] = useState<string>(SETTINGS_SECTIONS[0].id);
  // Infrastructure exists for an operator account only; the section mounts when
  // that answer arrives, so the measuring effect runs again then.
  const operator = useOperatorAccess();
  const sections = operator ? SETTINGS_SECTIONS : SETTINGS_SECTIONS.filter(({ id }) => id !== "infrastructure");

  useEffect(() => {
    const els = SETTINGS_SECTIONS.map(({ id }) => document.getElementById(id)).filter(
      (el): el is HTMLElement => el !== null,
    );
    const first = els[0];
    if (!first) return;

    const scroller = scrollerOf(first);
    const box = scroller ?? document.documentElement;
    const measure = () => {
      const origin = scroller ? scroller.getBoundingClientRect().top : 0;
      const viewportHeight = box.clientHeight;
      const anchorOffset = `${settingsAnchorOffset(viewportHeight)}px`;
      box.style.setProperty("--settings-anchor-offset", anchorOffset);
      const index = activeSectionIndex({
        sectionTops: els.map((el) => el.getBoundingClientRect().top - origin),
        viewportHeight,
      });
      setActive(els[index].id);
    };

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };

    measure();
    const scrollTarget = scroller ?? window;
    scrollTarget.addEventListener("scroll", schedule, { passive: true });
    // Cards load asynchronously and push the sections around without a scroll
    // event, and a viewport resize moves the activation line.
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(box);
    for (const el of els) resizeObserver.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      scrollTarget.removeEventListener("scroll", schedule);
      resizeObserver.disconnect();
    };
  }, [operator]);

  return (
    <nav aria-label="Settings sections" className={cx("flex flex-col gap-0.5", className)}>
      {sections.map(({ id, label }) => {
        const selected = active === id;
        return (
          <a
            key={id}
            href={`#${id}`}
            onClick={() => setActive(id)}
            aria-current={selected ? "true" : undefined}
            className={cx(
              "whitespace-nowrap rounded-2lg px-3 py-1.5 text-body-2-medium transition-colors duration-150",
              "outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
              selected
                ? "bg-background-secondary-hover font-semibold text-text-primary"
                : "text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary",
            )}
          >
            {label}
          </a>
        );
      })}
    </nav>
  );
}
