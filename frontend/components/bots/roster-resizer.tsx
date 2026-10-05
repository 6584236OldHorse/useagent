"use client";

import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { cx } from "@/utils/cx";

/** The roster must always fit a name, an outcome line and a time. */
export const ROSTER_MIN = 260;
export const ROSTER_MAX = 560;
/** The uncustomized width (md:w-80). */
export const ROSTER_DEFAULT = 320;
/** Target thread width when the split can also fit the roster minimum. */
const THREAD_FLOOR = 480;

const STORAGE_KEY = "useagent.bots-roster-width";

/** Clamp a wanted roster width to the range and to what the split can spare. */
export function rosterWidthFor({
  wanted,
  containerWidth,
  minimum = ROSTER_MIN,
  maximum = ROSTER_MAX,
}: {
  readonly wanted: number;
  readonly containerWidth: number;
  readonly minimum?: number;
  readonly maximum?: number;
}): number {
  const spare = Math.max(minimum, Math.min(maximum, containerWidth - THREAD_FLOOR));
  return Math.round(Math.min(Math.max(wanted, minimum), spare));
}

export function rosterMaximumFor(containerWidth: number): number {
  return rosterWidthFor({ wanted: ROSTER_MAX, containerWidth });
}

export function rosterLayoutFor({
  preferredWidth,
  containerWidth,
}: {
  readonly preferredWidth: number | null;
  readonly containerWidth: number;
}): { readonly width: number; readonly maximum: number } {
  return {
    width: rosterWidthFor({ wanted: preferredWidth ?? ROSTER_DEFAULT, containerWidth }),
    maximum: rosterMaximumFor(containerWidth),
  };
}

export function rosterWidthFromPointer({
  panelLeft,
  panelRight,
  containerWidth,
  pointerX,
  direction,
}: {
  readonly panelLeft: number;
  readonly panelRight: number;
  readonly containerWidth: number;
  readonly pointerX: number;
  readonly direction: "ltr" | "rtl";
}): number {
  const wanted = direction === "rtl" ? panelRight - pointerX : pointerX - panelLeft;
  return rosterWidthFor({ wanted, containerWidth });
}

export function rosterWidthForKey({
  key,
  current,
  containerWidth,
  direction = "ltr",
}: {
  readonly key: string;
  readonly current: number;
  readonly containerWidth: number;
  readonly direction?: "ltr" | "rtl";
}): number | null {
  if (key === "ArrowRight") {
    const wanted = direction === "rtl" ? current - 16 : current + 16;
    return rosterWidthFor({ wanted, containerWidth });
  }
  if (key === "ArrowLeft") {
    const wanted = direction === "rtl" ? current + 16 : current - 16;
    return rosterWidthFor({ wanted, containerWidth });
  }
  if (key === "Home") return ROSTER_MIN;
  if (key === "End") return rosterWidthFor({ wanted: ROSTER_MAX, containerWidth });
  return null;
}

type RosterBounds = {
  readonly panelLeft: number;
  readonly panelRight: number;
  readonly containerWidth: number;
  readonly direction: "ltr" | "rtl";
};

function measureRosterBounds(panel: HTMLElement | null): RosterBounds | null {
  const container = panel?.parentElement;
  if (!panel || !container) return null;
  const panelBounds = panel.getBoundingClientRect();
  const containerBounds = container.getBoundingClientRect();
  const direction = getComputedStyle(panel).direction === "rtl" ? "rtl" : "ltr";
  const containerWidth =
    direction === "rtl"
      ? panelBounds.right - containerBounds.left
      : containerBounds.right - panelBounds.left;
  return {
    panelLeft: panelBounds.left,
    panelRight: panelBounds.right,
    containerWidth,
    direction,
  };
}

/**
 * The shell roster persists its preferred width per browser. Its effective
 * width is clamped to the room beside the navigation rail, targeting a usable
 * thread width where space permits while preserving the user's preference.
 */
export function useRosterWidth({ panelRef }: { panelRef: RefObject<HTMLElement | null> }) {
  const [width, setWidth] = useState(ROSTER_DEFAULT);
  const [maximum, setMaximum] = useState(ROSTER_MAX);
  const preferredWidthRef = useRef<number | null>(null);
  const boundsRef = useRef<RosterBounds | null>(null);
  const dragWidthRef = useRef<number | null>(null);

  const persistPreferredWidth = useCallback((next: number | null) => {
    preferredWidthRef.current = next;
    try {
      if (next === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // Storage can be unavailable; the width still applies for this page.
    }
  }, []);

  const applyEffectiveWidth = useCallback(() => {
    const bounds = measureRosterBounds(panelRef.current);
    if (!bounds) return;
    const layout = rosterLayoutFor({
      preferredWidth: preferredWidthRef.current,
      containerWidth: bounds.containerWidth,
    });
    setMaximum((current) => (current === layout.maximum ? current : layout.maximum));
    setWidth((current) => (current === layout.width ? current : layout.width));
    panelRef.current?.style.setProperty("--roster-w", `${layout.width}px`);
  }, [panelRef]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const container = panel?.parentElement;
    if (!panel || !container) return;

    let saved = Number.NaN;
    try {
      saved = Number(localStorage.getItem(STORAGE_KEY));
    } catch {
      // Storage can be unavailable; resize observation still works.
    }
    if (Number.isFinite(saved) && saved >= ROSTER_MIN) {
      preferredWidthRef.current = rosterWidthFor({
        wanted: saved,
        containerWidth: ROSTER_MAX + THREAD_FLOOR,
      });
    }
    applyEffectiveWidth();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      boundsRef.current = null;
      applyEffectiveWidth();
    });
    observer.observe(container);
    if (panel.previousElementSibling instanceof HTMLElement) {
      observer.observe(panel.previousElementSibling);
    }
    return () => observer.disconnect();
  }, [applyEffectiveWidth, panelRef]);

  const resizeFromPointer = useCallback(
    (pointerX: number) => {
      boundsRef.current ??= measureRosterBounds(panelRef.current);
      const bounds = boundsRef.current;
      if (!bounds) return;
      const next = rosterWidthFromPointer({ ...bounds, pointerX });
      dragWidthRef.current = next;
      panelRef.current?.style.setProperty("--roster-w", `${next}px`);
    },
    [panelRef],
  );

  const commit = useCallback(() => {
    boundsRef.current = null;
    const next = dragWidthRef.current;
    dragWidthRef.current = null;
    if (next === null) return;
    persistPreferredWidth(next);
    applyEffectiveWidth();
  }, [applyEffectiveWidth, persistPreferredWidth]);

  const reset = useCallback(() => {
    boundsRef.current = null;
    dragWidthRef.current = null;
    persistPreferredWidth(null);
    applyEffectiveWidth();
  }, [applyEffectiveWidth, persistPreferredWidth]);

  const resizeWithKeyboard = (key: string) => {
    const bounds = measureRosterBounds(panelRef.current);
    const containerWidth = bounds?.containerWidth ?? ROSTER_MAX + THREAD_FLOOR;
    const next = rosterWidthForKey({
      key,
      current: width,
      containerWidth,
      direction: bounds?.direction,
    });
    if (next === null) return;
    persistPreferredWidth(next);
    applyEffectiveWidth();
  };

  return { width, maximum, resizeFromPointer, commit, reset, resizeWithKeyboard };
}

/** The drag grip between the shell roster and the selected bot's thread. */
export function RosterResizer({
  value,
  maximum,
  onMove,
  onCommit,
  onKeyDown,
  onReset,
}: {
  readonly value: number;
  readonly maximum: number;
  readonly onMove: (pointerX: number) => void;
  readonly onCommit: () => void;
  readonly onKeyDown: (key: string) => void;
  readonly onReset: () => void;
}) {
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const pendingXRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);

  const flush = () => {
    frameRef.current = null;
    if (pendingXRef.current === null) return;
    const x = pendingXRef.current;
    pendingXRef.current = null;
    onMove(x);
  };

  const finish = (element: HTMLHRElement, pointerId?: number) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setDragging(false);
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    flush();
    if (pointerId !== undefined && element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
    onCommit();
  };

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      pendingXRef.current = null;
      draggingRef.current = false;
    },
    [],
  );

  return (
    <hr
      data-testid="roster-resize-grip"
      data-dragging={dragging}
      tabIndex={0}
      aria-orientation="vertical"
      aria-label="Resize the bots list; double-click to reset"
      aria-valuemin={ROSTER_MIN}
      aria-valuemax={maximum}
      aria-valuenow={value}
      aria-valuetext={`${value} pixels`}
      onPointerDown={(event) => {
        event.preventDefault();
        draggingRef.current = true;
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!draggingRef.current) return;
        pendingXRef.current = event.clientX;
        frameRef.current ??= requestAnimationFrame(flush);
      }}
      onPointerUp={(event) => finish(event.currentTarget, event.pointerId)}
      onPointerCancel={(event) => finish(event.currentTarget, event.pointerId)}
      onLostPointerCapture={(event) => finish(event.currentTarget)}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        onKeyDown(event.key);
      }}
      onDoubleClick={onReset}
      className={cx(
        "peer relative -mx-2 hidden h-auto w-4 shrink-0 cursor-col-resize touch-none self-stretch border-0 bg-transparent outline-none md:block",
        "before:absolute before:inset-y-3 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent before:transition-colors before:content-['']",
        "after:absolute after:left-1/2 after:top-1/2 after:h-12 after:w-3 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:border after:border-border-button-default after:bg-background-primary-default after:shadow-card after:transition-[border-color,background-color,box-shadow,transform] after:content-['']",
        "hover:before:bg-border-button-hover hover:after:border-accent-500 focus-visible:before:bg-accent-500 focus-visible:after:border-accent-500 focus-visible:after:ring-2 focus-visible:after:ring-accent-500/15",
        dragging &&
          "before:bg-accent-500 after:scale-110 after:border-accent-500 after:bg-accent-500/10",
      )}
    />
  );
}
