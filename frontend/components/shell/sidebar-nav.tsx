import { RiArrowDownSLine } from "@remixicon/react";
import Link from "next/link";
import type { ComponentType, ReactNode } from "react";

import { cx } from "@/utils/cx";

/**
 * Shared building blocks for the app-shell sidebars (chat + agent). The
 * expanded rail is a flat, edge-to-edge column (single hairline border-r, no
 * inset or shadow); only the collapsed compact rail keeps the floating-dock
 * treatment. Each holds a scrollable nav column with icon rows,
 * `text-mono-label` section headers, and left-aligned "Recents" rows — so the
 * row + section primitives live here instead of being duplicated per sidebar.
 *
 * Server component: presentational + `next/link` only, no hooks.
 */

type IconComponent = ComponentType<{
  className?: string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

export function Sidebar({
  ariaLabel,
  children,
  header,
  footer,
}: {
  ariaLabel: string;
  children: ReactNode;
  header?: ReactNode;
  /** Optional pinned block below the scroll area (e.g. "Connect apps"). */
  footer?: ReactNode;
}) {
  return (
    <div className="h-full w-full">
      <aside
        aria-label={ariaLabel}
        className="flex h-full w-full flex-col overflow-hidden border-r border-border-button-white bg-background-secondary-default"
      >
        {header}
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-1.5">{children}</nav>
        {footer}
      </aside>
    </div>
  );
}

export function SidebarSectionLabel({ children }: { children: ReactNode }) {
  return <p className="text-mono-label px-2.5 pb-1 pt-3 text-text-tertiary">{children}</p>;
}

/**
 * A section label that folds its section: the whole heading is the control, so
 * a list expanded with "Show N more" closes from the top without scrolling back
 * to its foot. Same type and spacing as the plain label, plus a chevron.
 */
export function SidebarSectionToggle({
  children,
  open,
  onToggle,
  controls,
}: {
  children: ReactNode;
  open: boolean;
  onToggle: () => void;
  controls?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className="text-mono-label flex w-full items-center gap-1 rounded-lg px-2.5 pb-1 pt-3 text-left text-text-tertiary transition-colors hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
    >
      <span className="min-w-0 flex-1">{children}</span>
      <RiArrowDownSLine
        aria-hidden
        className={cx("size-3.5 shrink-0 transition-transform", !open && "-rotate-90")}
      />
    </button>
  );
}

export type NavIconTone = "blue" | "purple" | "green" | "orange" | "primary";

/** Nav icons share the idle label colour (text-secondary clears 3:1 on the rail
 *  in every theme, unlike the icon-tertiary grey). The tones stay as routing
 *  metadata only, so a future accent can return without touching every route. */
export const NAV_ICON_TONE: Record<NavIconTone, string> = {
  blue: "text-text-secondary",
  purple: "text-text-secondary",
  green: "text-text-secondary",
  orange: "text-text-secondary",
  primary: "text-text-secondary",
};

export interface SidebarNavItemProps {
  href?: string;
  /** Optional brand tint for the leading icon (adds subtle color). */
  tone?: NavIconTone;
  /** Leading remixicon component. Omit for icon-less "Recents" rows. */
  icon?: IconComponent;
  /** Custom leading node (e.g. a status dot) — wins over `icon`. */
  leading?: ReactNode;
  label: string;
  active?: boolean;
  /** Pass false to keep a link out of viewport prefetch (see Route.prefetch). */
  prefetch?: boolean;
  /** Trailing node, e.g. a "New" chip. */
  trailing?: ReactNode;
}

export function SidebarNavItem({
  href = "#",
  tone,
  icon: Icon,
  leading,
  label,
  active = false,
  trailing,
  prefetch,
}: SidebarNavItemProps) {
  return (
    <Link
      href={href}
      prefetch={prefetch}
      aria-current={active ? "page" : undefined}
      className={cx(
        "flex items-center gap-2 rounded-2lg px-2.5 py-1.5 text-body-2-medium transition-colors",
        active
          ? "bg-background-secondary-hover font-semibold text-text-primary"
          : "text-text-secondary hover:bg-background-secondary-hover hover:text-text-primary",
      )}
    >
      <span className="flex w-4 shrink-0 items-center justify-center">
        {leading ??
          (Icon ? (
            <Icon
              className={cx(
                "size-3.5 shrink-0",
                active
                  ? "text-text-primary"
                  : tone
                    ? NAV_ICON_TONE[tone]
                    : "text-text-secondary",
              )}
              aria-hidden
            />
          ) : null)}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </Link>
  );
}
