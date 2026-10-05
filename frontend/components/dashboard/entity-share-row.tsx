import type * as React from "react";

import { cx } from "@/utils/cx";

/**
 * One ranked entity row in the kobbe "sources" grammar: a gray-fill pill whose
 * WIDTH encodes the row's share of the list max (the rank bar IS the pill), the
 * label sitting inside it, and a right-aligned muted tabular count. No borders,
 * one accent-free palette - ranking is carried by width, never colour.
 *
 * Presentational only: callers own navigation/disclosure by wrapping the row
 * (e.g. a Link or a disclosure button) and pass the pre-computed `max`.
 */
export interface EntityShareRowProps {
  label: string;
  /** Numeric value: drives both the pill width and the shown count. */
  value: number;
  /** Largest value across the list, so the pill widths are comparable. */
  max: number;
  /** Optional small leading glyph inside the pill. */
  icon?: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" | "false" }>;
  /** Count formatter (defaults to a plain integer). */
  formatValue?: (n: number) => string;
  /** Full text for the row's title attribute (defaults to `label`). */
  title?: string;
  /** Rendered before the pill, e.g. a disclosure chevron. */
  leading?: React.ReactNode;
  /** Small muted text between the pill and the count, e.g. a status caption. */
  caption?: React.ReactNode;
  /** Rendered after the count, e.g. an external-link glyph or status cluster. */
  trailing?: React.ReactNode;
  className?: string;
}

export function EntityShareRow({
  label,
  value,
  max,
  icon: Icon,
  formatValue = (n) => String(n),
  title,
  leading,
  caption,
  trailing,
  className,
}: EntityShareRowProps) {
  // Share of the max, floored so a non-zero row always shows a visible bar.
  // The bar is a background layer so long labels stay readable without changing
  // the proportion it encodes.
  const pct = max > 0 ? Math.max(6, Math.round((value / max) * 100)) : 0;
  return (
    <div className={cx("flex items-center gap-2", className)}>
      {leading}
      <div className="relative min-w-0 flex-1 px-2.5 py-1.5" title={title ?? label}>
        <div
          aria-hidden
          className="absolute inset-y-0 start-0 rounded-2lg bg-background-secondary-default"
          style={{ width: `${pct}%` }}
        />
        <div className="relative flex min-w-0 items-start gap-1.5">
          {Icon && <Icon className="size-4 shrink-0 text-text-secondary" aria-hidden />}
          <span className="min-w-0 [overflow-wrap:anywhere] text-body-2-medium text-text-primary">
            {label}
          </span>
        </div>
      </div>
      {caption}
      <span className="shrink-0 text-body-2-regular tabular-nums text-text-tertiary">
        {formatValue(value)}
      </span>
      {trailing}
    </div>
  );
}
