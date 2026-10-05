"use client";

import { type ReactNode, useMemo, useState } from "react";
import {
  RiArrowDownSLine,
  RiArrowUpSLine,
  RiLinksLine,
  RiPriceTag3Line,
  RiPulseLine,
  RiTimeLine,
} from "@remixicon/react";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { cx } from "@/utils/cx";

/**
 * Tag-heavy records table — a horizontally scrollable companies grid with a
 * sticky first column (select checkbox + letter mark + name), colored category
 * tags, a relative last-interaction, a tone-colored connection-strength dot, and
 * a links cell. Company, last-interaction, and strength headers sort on click
 * (toggle asc/desc), following the upstream refresh. Ported from the
 * beautiful-ui RecordsTable demo (hardcoded → parameterized) onto our tokens.
 */

export type RecordTagColor =
  | "purple"
  | "pink"
  | "blue"
  | "green"
  | "orange"
  | "teal"
  | "sky"
  | "yellow"
  | "red"
  | "neutral";

const tagDot: Record<RecordTagColor, string> = {
  purple: "bg-purple-500",
  pink: "bg-pink-500",
  blue: "bg-blue-500",
  green: "bg-green-500",
  orange: "bg-orange-500",
  teal: "bg-teal-500",
  sky: "bg-sky-500",
  yellow: "bg-yellow-500",
  red: "bg-red-500",
  neutral: "bg-foreground-icon-tertiary",
};

export type StrengthTone = "critical" | "weak" | "neutral" | "strong";

const strengthDot: Record<StrengthTone, string> = {
  critical: "bg-red-500",
  weak: "bg-yellow-500",
  neutral: "bg-foreground-icon-tertiary",
  strong: "bg-lime-500",
};

const strengthRank: Record<StrengthTone, number> = {
  critical: 0,
  weak: 1,
  neutral: 2,
  strong: 3,
};

type SortKey = "company" | "last" | "strength";

// The table's visual grammar, exported so a data grid elsewhere (the workbook
// editor) draws with this exact component instead of a second table: the same
// frame, header cells, rows, sticky name cell, tags and footer count.

/** Sticky first column that keeps the row's hover tint. */
export const RECORDS_STICKY =
  "sticky left-0 z-10 bg-background-primary-default group-hover/row:bg-background-primary-hover";
export const RECORDS_HEADER_CELL = "text-caption-1-medium text-text-tertiary px-3 py-2 font-medium";
export const RECORDS_ROW =
  "group/row border-border-button-default hover:bg-background-primary-hover border-b transition-colors duration-100 last:border-0";
export const RECORDS_CELL = "px-3 py-2.5";
export const RECORDS_SORT_BUTTON = "flex items-center gap-1 transition-colors hover:text-text-secondary";

export function RecordsSortMark({ direction }: { direction: 1 | -1 | null }) {
  if (direction === null) return null;
  const Arrow = direction === 1 ? RiArrowUpSLine : RiArrowDownSLine;
  return <Arrow className="size-3.5 shrink-0 text-text-secondary" aria-hidden />;
}

/** The letter mark and name that lead every row. */
export function RecordsNameCell({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        aria-hidden
        className="bg-background-tertiary-default text-text-secondary flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold"
      >
        {name.charAt(0).toUpperCase()}
      </span>
      <span className="text-body-2-medium text-text-primary whitespace-nowrap">{name}</span>
    </div>
  );
}

export function RecordsTag({ tag }: { tag: RecordTag }) {
  return (
    <span className="bg-background-secondary-default text-text-secondary inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11.5px] font-medium">
      <span className={cx("size-1.5 rounded-full", tagDot[tag.color ?? "neutral"])} aria-hidden />
      {tag.label}
    </span>
  );
}

/** The frame: the bordered card, the table, and the upstream's footer row with the
 *  record count in the sticky cell. `fill` stretches the frame to its pane. */
export function RecordsTableFrame({
  count,
  columns,
  fill = false,
  className,
  children,
}: {
  /** Records shown; the footer says "n count" like the upstream table. */
  count: number;
  /** Cells the footer spans beyond the sticky one, so its border runs the width. */
  columns: number;
  fill?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "border-border-button-default bg-background-primary-default shadow-sm overflow-auto rounded-xl border",
        fill && "min-h-0 flex-1",
        className,
      )}
    >
      <table className="w-full border-collapse text-left">
        {children}
        <tfoot>
          <tr className="border-border-button-default border-t">
            <td className={cx(RECORDS_STICKY, "px-3 py-2 text-caption-1-regular text-text-tertiary whitespace-nowrap")}>
              <span className="text-text-secondary tabular-nums">{count}</span> count
            </td>
            {Array.from({ length: columns }, (_, index) => (
              <td key={index} className="px-3 py-2 text-caption-1-regular text-text-tertiary">
                -
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export interface RecordTag {
  label: string;
  color?: RecordTagColor;
}

export interface RecordRow {
  company: string;
  categories?: RecordTag[];
  lastInteraction?: string;
  strength?: { label: string; tone: StrengthTone };
  links?: { label: string; href?: string }[];
}

export interface RecordsTableProps {
  rows: RecordRow[];
  className?: string;
}

function HeaderIcon({ as: Icon }: { as: typeof RiTimeLine }) {
  return <Icon className="text-text-tertiary size-3.5 shrink-0" aria-hidden />;
}

export function RecordsTable({ rows, className }: RecordsTableProps) {
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const allSelected = rows.length > 0 && selected.size === rows.length;

  function toggle(index: number, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  function toggleAll(on: boolean) {
    setSelected(on ? new Set(rows.map((_, i) => i)) : new Set());
  }

  function toggleSort(key: SortKey) {
    setSort((prev) => (prev?.key === key ? { key, dir: prev.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  }

  // Selection stays keyed on the original row index so sorting never scrambles it.
  const orderedRows = useMemo(() => {
    const indexed = rows.map((row, index) => ({ row, index }));
    if (!sort) return indexed;
    return indexed.toSorted(
      (a, b) =>
        (sort.key === "company"
          ? a.row.company.localeCompare(b.row.company)
          : sort.key === "last"
            ? (a.row.lastInteraction ?? "").localeCompare(b.row.lastInteraction ?? "")
            : (a.row.strength ? strengthRank[a.row.strength.tone] : -1) -
              (b.row.strength ? strengthRank[b.row.strength.tone] : -1)) * sort.dir,
    );
  }, [rows, sort]);

  function SortMark({ column }: { column: SortKey }) {
    return <RecordsSortMark direction={sort?.key === column ? sort.dir : null} />;
  }

  return (
    <RecordsTableFrame count={rows.length} columns={4} className={className}>
        <thead>
          <tr className="border-border-button-default border-b">
            <th
              aria-sort={
                sort?.key === "company" ? (sort.dir === 1 ? "ascending" : "descending") : undefined
              }
              className={cx(RECORDS_STICKY, "bg-background-primary-default", RECORDS_HEADER_CELL)}
            >
              <div className="flex items-center gap-2.5">
                <Checkbox
                  isSelected={allSelected}
                  onChange={(v) => toggleAll(v)}
                />
                <button type="button" onClick={() => toggleSort("company")} className={RECORDS_SORT_BUTTON}>
                  Company
                  <SortMark column="company" />
                </button>
              </div>
            </th>
            <th className={RECORDS_HEADER_CELL}>
              <span className="flex items-center gap-1.5">
                <HeaderIcon as={RiPriceTag3Line} />
                Categories
              </span>
            </th>
            <th
              aria-sort={
                sort?.key === "last" ? (sort.dir === 1 ? "ascending" : "descending") : undefined
              }
              className={RECORDS_HEADER_CELL}
            >
              <button type="button" onClick={() => toggleSort("last")} className={cx(RECORDS_SORT_BUTTON, "gap-1.5")}>
                <HeaderIcon as={RiTimeLine} />
                Last interaction
                <SortMark column="last" />
              </button>
            </th>
            <th
              aria-sort={
                sort?.key === "strength" ? (sort.dir === 1 ? "ascending" : "descending") : undefined
              }
              className={RECORDS_HEADER_CELL}
            >
              <button type="button" onClick={() => toggleSort("strength")} className={cx(RECORDS_SORT_BUTTON, "gap-1.5")}>
                <HeaderIcon as={RiPulseLine} />
                Connection strength
                <SortMark column="strength" />
              </button>
            </th>
            <th className={RECORDS_HEADER_CELL}>
              <span className="flex items-center gap-1.5">
                <HeaderIcon as={RiLinksLine} />
                Links
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {orderedRows.map(({ row, index: ri }) => (
            <tr key={`${row.company}-${ri}`} className={RECORDS_ROW}>
              <td className={cx(RECORDS_STICKY, RECORDS_CELL)}>
                <div className="flex items-center gap-2.5">
                  <Checkbox
                    isSelected={selected.has(ri)}
                    onChange={(v) => toggle(ri, v)}
                  />
                  <RecordsNameCell name={row.company} />
                </div>
              </td>
              <td className={RECORDS_CELL}>
                <div className="flex flex-wrap gap-1">
                  {(row.categories ?? []).map((tag) => (
                    <RecordsTag key={tag.label} tag={tag} />
                  ))}
                </div>
              </td>
              <td className={cx(RECORDS_CELL, "text-text-secondary whitespace-nowrap text-caption-1-regular")}>
                {row.lastInteraction ?? "-"}
              </td>
              <td className={RECORDS_CELL}>
                {row.strength ? (
                  <span className="text-text-secondary inline-flex items-center gap-1.5 whitespace-nowrap text-caption-1-regular">
                    <span
                      className={cx(
                        "size-1.5 rounded-full",
                        strengthDot[row.strength.tone],
                      )}
                      aria-hidden
                    />
                    {row.strength.label}
                  </span>
                ) : (
                  <span className="text-text-tertiary">-</span>
                )}
              </td>
              <td className={RECORDS_CELL}>
                {row.links && row.links.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {row.links.map((link) =>
                      link.href ? (
                        <a
                          key={link.label}
                          href={link.href}
                          target="_blank"
                          rel="noreferrer"
                          className="text-text-secondary hover:text-text-primary whitespace-nowrap text-caption-1-regular underline underline-offset-2 transition-colors"
                        >
                          {link.label}
                        </a>
                      ) : (
                        <span
                          key={link.label}
                          className="text-text-secondary whitespace-nowrap text-caption-1-regular"
                        >
                          {link.label}
                        </span>
                      ),
                    )}
                  </div>
                ) : (
                  <span className="text-text-tertiary">-</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
    </RecordsTableFrame>
  );
}
