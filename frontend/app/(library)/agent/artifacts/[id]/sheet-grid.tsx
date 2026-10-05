"use client";

// The spreadsheet artifact as a records grid, drawn with the AI kit's records
// table (components/ai/records-table.tsx): row 1 names the columns, every later
// row is a record, and each column's type (read off its cells in
// sheet-records.ts) decides how it draws: tag chips, relative dates, a tone dot
// with its label, links, right-aligned numbers, or text. Headers sort, the
// footer runs a calculation per column, the bottom bar filters and switches
// sheets as views. Editing is inline: double-click a cell, type, Enter. No
// formula bar and no format toolbar; a cell that holds a formula shows its
// value and an edit replaces it with the typed value. Cell fill and text
// colours are document data and apply as inline styles. The visible grid is
// capped (windowed) so a 10000-row sheet never renders raw.

import { RiAddLine, RiCloseLine, RiFilter3Line, RiHashtag, RiLinksLine, RiPriceTag3Line, RiPulseLine, RiTimeLine } from "@remixicon/react";
import {
  activeWorksheet,
  evaluateWorkbook,
  formatA1,
  parseA1,
  SHEET_MAX_COLS,
  SHEET_MAX_ROWS,
  WORKBOOK_MAX_SHEETS,
  type Workbook,
  type Worksheet,
} from "@useagent/artifact-workspace";
import { useEffect, useMemo, useState } from "react";
import {
  RECORDS_CELL,
  RECORDS_HEADER_CELL,
  RECORDS_HEADER_STICKY,
  RECORDS_ROW,
  RECORDS_SORT_BUTTON,
  RECORDS_STICKY,
  RecordsHeaderIcon,
  RecordsLink,
  RecordsNameCell,
  RecordsSortMark,
  RecordsStatus,
  RecordsTableFrame,
  RecordsTag,
} from "@/components/ai/records-table";
import { cx } from "@/utils/cx";
import { relativeTimeShort } from "@/utils/format";
import {
  CALCULATION_LABELS,
  calculate,
  calculationsFor,
  columnTypes,
  filledRecordCount,
  filterOps,
  filterRecords,
  linkHref,
  parseDate,
  sheetRecords,
  sortedRecords,
  splitTags,
  statusTone,
  statusTones,
  tagColor,
  VISIBLE_COL_CAP,
  VISIBLE_ROW_CAP,
  type SheetCalculation,
  type SheetColumnType,
  type SheetFilter,
  type SheetFilterOp,
  type SheetRecordCell,
  type SheetSort,
} from "./sheet-records";

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

// --- Pure workbook mutations -----------------------------------------------

function replaceSheet(workbook: Workbook, next: Worksheet): Workbook {
  return { ...workbook, sheets: workbook.sheets.map((sheet) => (sheet.id === next.id ? next : sheet)) };
}

function grownDimensions(sheet: Worksheet, row: number, col: number): Worksheet {
  const rowCount = Math.min(SHEET_MAX_ROWS, Math.max(sheet.rowCount, row + 1));
  const colCount = Math.min(SHEET_MAX_COLS, Math.max(sheet.colCount, col + 1));
  return rowCount === sheet.rowCount && colCount === sheet.colCount
    ? sheet
    : { ...sheet, rowCount, colCount };
}

/** Commit a raw cell input (a formula, a number, text, or empty) into the sheet.
 * A formula caches its computed value in `v` so the CSV/XLSX downgrade keeps a
 * value; a numeric input is stored as a number so number formats apply. */
export function commitCell(workbook: Workbook, sheetId: string, ref: string, raw: string): Workbook {
  const position = parseA1(ref);
  const sheet = workbook.sheets.find((item) => item.id === sheetId);
  if (!position || !sheet) return workbook;
  const prevFmt = sheet.cells[ref]?.fmt;
  const cells = { ...sheet.cells };

  if (raw === "") {
    if (prevFmt) cells[ref] = { v: "", fmt: prevFmt };
    else delete cells[ref];
  } else if (raw.startsWith("=")) {
    cells[ref] = { v: "", f: raw, ...(prevFmt ? { fmt: prevFmt } : {}) };
  } else if (NUMERIC.test(raw.trim())) {
    cells[ref] = { v: Number(raw.trim()), ...(prevFmt ? { fmt: prevFmt } : {}) };
  } else {
    cells[ref] = { v: raw, ...(prevFmt ? { fmt: prevFmt } : {}) };
  }

  let next = grownDimensions({ ...sheet, cells }, position.row, position.col);
  let workbookNext = replaceSheet(workbook, next);

  // Cache the formula's computed scalar into `v` (never the display string) so a
  // downgrade export keeps a real value. A boolean result caches as its text.
  if (raw.startsWith("=")) {
    const evaluated = evaluateWorkbook(workbookNext).cell(sheetId, ref);
    const result = evaluated.error ?? evaluated.value ?? "";
    const cached: string | number = typeof result === "boolean"
      ? result ? "TRUE" : "FALSE"
      : result;
    next = { ...next, cells: { ...next.cells, [ref]: { v: cached, f: raw, ...(prevFmt ? { fmt: prevFmt } : {}) } } };
    workbookNext = replaceSheet(workbook, next);
  }
  return workbookNext;
}

function uniqueSheetId(workbook: Workbook): string {
  const ids = new Set(workbook.sheets.map((sheet) => sheet.id));
  let n = workbook.sheets.length + 1;
  while (ids.has(`sheet-${n}`)) n += 1;
  return `sheet-${n}`;
}

function addSheet(workbook: Workbook): Workbook {
  if (workbook.sheets.length >= WORKBOOK_MAX_SHEETS) return workbook;
  const id = uniqueSheetId(workbook);
  const names = new Set(workbook.sheets.map((sheet) => sheet.name));
  let index = workbook.sheets.length + 1;
  while (names.has(`Sheet ${index}`)) index += 1;
  const sheet: Worksheet = { id, name: `Sheet ${index}`, cells: {}, rowCount: 20, colCount: 8 };
  return { ...workbook, sheets: [...workbook.sheets, sheet], activeSheetId: id };
}

function renameSheet(workbook: Workbook, sheetId: string, name: string): Workbook {
  const trimmed = name.trim().slice(0, 128) || "Sheet";
  return {
    ...workbook,
    sheets: workbook.sheets.map((sheet) => (sheet.id === sheetId ? { ...sheet, name: trimmed } : sheet)),
  };
}

// --- Viewer preferences ------------------------------------------------------

type CalculationChoices = Readonly<Record<string, Readonly<Record<string, SheetCalculation>>>>;

function calculationStorageKey(storageKey: string): string {
  return `useagent.sheet-calculations.${storageKey}`;
}

/** The viewer's footer calculations for one artifact; empty when none or when
 *  storage is unavailable (a private window, blocked site data). */
function loadCalculations(storageKey: string | undefined): CalculationChoices {
  if (!storageKey) return {};
  try {
    const raw = localStorage.getItem(calculationStorageKey(storageKey));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as CalculationChoices) : {};
  } catch {
    return {};
  }
}

function saveCalculations(storageKey: string | undefined, choices: CalculationChoices): void {
  if (!storageKey) return;
  try {
    localStorage.setItem(calculationStorageKey(storageKey), JSON.stringify(choices));
  } catch {
    // A viewer convenience only; nothing to recover.
  }
}

// --- Cells by type ------------------------------------------------------------

const HEADER_ICON: Partial<Record<SheetColumnType, typeof RiTimeLine>> = {
  tags: RiPriceTag3Line,
  date: RiTimeLine,
  status: RiPulseLine,
  url: RiLinksLine,
  number: RiHashtag,
};

const FILTER_OP_LABELS: Record<SheetFilterOp, string> = {
  contains: "contains",
  equals: "is",
  before: "before",
  after: "after",
};

/** How long ago, in the rail's short form for the first weeks, then months and
 *  years so an old date never reads as "95w". A date still ahead reads as itself. */
function dateLabel(display: string, now = Date.now()): string {
  const ms = parseDate(display);
  if (ms === null) return display;
  if (ms > now) return display.trim().slice(0, 10);
  const days = Math.floor((now - ms) / 86_400_000);
  if (days < 56) return relativeTimeShort(ms, now);
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

function TypedCell({
  cell,
  type,
  tones,
}: {
  readonly cell: SheetRecordCell;
  readonly type: SheetColumnType;
  readonly tones: ReadonlyMap<string, "critical" | "weak" | "neutral" | "strong">;
}) {
  const display = cell.display.trim();
  if (cell.error) return <span className="text-caption-1-regular text-text-error-primary">{cell.display}</span>;
  if (display === "") return <span className="text-text-tertiary">{" "}</span>;
  switch (type) {
    case "tags":
      return (
        <span className="flex flex-nowrap gap-1">
          {splitTags(display).map((tag, index) => (
            <RecordsTag key={`${tag}-${index}`} tag={{ label: tag, color: tagColor(tag) }} />
          ))}
        </span>
      );
    case "status":
      return <RecordsStatus label={display} tone={statusTone(display, tones)} />;
    case "url":
      return <RecordsLink label={display.replace(/^https?:\/\//i, "")} href={linkHref(display)} />;
    case "date":
      return (
        <span title={display} className="whitespace-nowrap text-caption-1-regular text-text-secondary">
          {dateLabel(display)}
        </span>
      );
    case "number":
      return (
        <span style={cell.style} className="block text-right text-caption-1-regular tabular-nums text-text-secondary">
          {cell.display}
        </span>
      );
    default:
      return (
        <span
          style={cell.style}
          className="block max-w-[28rem] truncate text-caption-1-regular text-text-secondary"
        >
          {cell.display}
        </span>
      );
  }
}

function CellEditor({
  initial,
  onCommit,
  onCancel,
}: {
  readonly initial: string;
  readonly onCommit: (value: string) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: the field opens on the cell the person just double-clicked.
      autoFocus
      value={draft}
      aria-label="Cell value"
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit(draft);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      }}
      className="w-full min-w-24 rounded-md bg-background-primary-default px-1.5 py-0.5 text-body-2-regular text-text-primary outline-none ring-2 ring-inset ring-border-focus-ring"
    />
  );
}

// --- The surface ----------------------------------------------------------------

export function SheetGridSurface({
  workbook,
  loading,
  onChange,
  storageKey,
}: {
  readonly workbook: Workbook | null;
  readonly loading: boolean;
  readonly onChange: (workbook: Workbook) => void;
  /** Keys the viewer's footer calculations (the artifact id); absent keeps none. */
  readonly storageKey?: string;
}) {
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [sort, setSort] = useState<SheetSort | null>(null);
  const [filters, setFilters] = useState<readonly SheetFilter[]>([]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [calculations, setCalculations] = useState<CalculationChoices>(() => loadCalculations(storageKey));

  const sheet = workbook ? activeWorksheet(workbook) : null;
  const evaluation = useMemo(() => (workbook ? evaluateWorkbook(workbook) : null), [workbook]);
  const table = useMemo(() => (sheet && evaluation ? sheetRecords(sheet, evaluation) : null), [sheet, evaluation]);
  const types = useMemo(() => (table ? columnTypes(table.columns, table.records) : []), [table]);
  const tones = useMemo(
    () =>
      table
        ? types.map((type, index) =>
            type === "status"
              ? statusTones(table.records.map((record) => record.cells[index]!.display))
              : new Map<string, "critical" | "weak" | "neutral" | "strong">(),
          )
        : [],
    [table, types],
  );
  const visible = useMemo(
    () => (table ? sortedRecords(filterRecords(table.records, filters), sort) : []),
    [table, filters, sort],
  );
  const viewCounts = useMemo(
    () =>
      workbook && evaluation
        ? new Map(workbook.sheets.map((item) => [item.id, filledRecordCount(sheetRecords(item, evaluation).records)]))
        : new Map<string, number>(),
    [workbook, evaluation],
  );

  // Filters and sort belong to the sheet they were built on.
  const sheetId = sheet?.id;
  useEffect(() => {
    setFilters([]);
    setSort(null);
    setEditing(null);
    setFiltersOpen(false);
  }, [sheetId]);

  if (!workbook || !sheet || !evaluation || !table) {
    return (
      <p className="mt-4 rounded-xl border border-dashed border-border-button-default px-4 py-8 text-center text-body-2-regular text-text-secondary">
        Loading workbook...
      </p>
    );
  }

  const capped = sheet.rowCount > VISIBLE_ROW_CAP || sheet.colCount > VISIBLE_COL_CAP;
  const sheetCalculations = calculations[sheet.id] ?? {};

  const rawOf = (row: number, col: number): string => {
    const cell = sheet.cells[formatA1(row, col)];
    return cell ? String(cell.v) : "";
  };
  const commit = (row: number, col: number, value: string) => {
    if (value !== rawOf(row, col)) onChange(commitCell(workbook, sheet.id, formatA1(row, col), value));
    setEditing(null);
  };
  const toggleSort = (col: number) =>
    setSort((current) => (current?.col === col ? { col, dir: current.dir === 1 ? -1 : 1 } : { col, dir: 1 }));
  const chooseCalculation = (col: number, calculation: SheetCalculation | "") => {
    const next: Record<string, SheetCalculation> = { ...sheetCalculations };
    if (calculation === "") delete next[col];
    else next[col] = calculation;
    const choices = { ...calculations, [sheet.id]: next };
    setCalculations(choices);
    saveCalculations(storageKey, choices);
  };
  const addRow = () => {
    if (loading || sheet.rowCount >= SHEET_MAX_ROWS) return;
    const row = sheet.rowCount;
    onChange(replaceSheet(workbook, grownDimensions(sheet, row, sheet.colCount - 1)));
    setFilters([]);
    setSort(null);
    setEditing({ row, col: 0 });
  };
  const addColumn = () => {
    if (loading || sheet.colCount >= SHEET_MAX_COLS) return;
    const col = sheet.colCount;
    onChange(replaceSheet(workbook, grownDimensions(sheet, sheet.rowCount - 1, col)));
    setEditing({ row: 0, col });
  };
  const addFilter = () => {
    const col = table.columns.length > 1 ? 1 : 0;
    setFilters((current) => [...current, { col, op: filterOps(types[col] ?? "text")[0]!, value: "" }]);
    setFiltersOpen(true);
  };
  const activeFilters = filters.filter((filter) => filter.value.trim() !== "").length;

  return (
    // Bounded to the viewport where nothing else bounds it (the artifact page), so
    // the frame scrolls its rows and keeps the footer in view; a pane bounds it first.
    <section className="mt-3 flex h-full max-h-[calc(100dvh-7rem)] min-h-0 flex-1 flex-col gap-2">
      <RecordsTableFrame
        count={visible.length}
        columns={table.columns.length}
        fill
        footerCells={[
          ...table.columns.slice(1).map((column, offset) => {
            const index = offset + 1;
            const type = types[index] ?? "text";
            const chosen = sheetCalculations[column.col];
            const cells = visible.map((record) => record.cells[index]!);
            return (
              <select
                key={column.col}
                aria-label={`Calculation for ${column.label}`}
                value={chosen ?? ""}
                onChange={(event) => chooseCalculation(column.col, event.currentTarget.value as SheetCalculation | "")}
                className={cx(
                  "max-w-full cursor-pointer appearance-none bg-transparent text-caption-1-regular outline-none focus-visible:underline",
                  chosen ? "text-text-secondary tabular-nums" : "text-text-tertiary",
                )}
              >
                <option value="">{chosen ? "None" : "+ Add calculation"}</option>
                {calculationsFor(type).map((calculation) => (
                  <option key={calculation} value={calculation}>
                    {calculate(calculation, cells, type)} {CALCULATION_LABELS[calculation].toLowerCase()}
                  </option>
                ))}
              </select>
            );
          }),
          "",
        ]}
      >
        <thead>
          <tr className="border-border-button-default border-b">
            {table.columns.map((column, index) => {
              const type = types[index] ?? "text";
              const Icon = HEADER_ICON[type];
              const editingHeader = editing?.row === 0 && editing.col === column.col;
              return (
                <th
                  key={column.col}
                  aria-sort={sort?.col === column.col ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
                  className={cx(
                    RECORDS_HEADER_STICKY,
                    index === 0 && cx(RECORDS_STICKY, "left-0 z-30"),
                    RECORDS_HEADER_CELL,
                    "whitespace-nowrap",
                  )}
                >
                  {editingHeader ? (
                    <CellEditor
                      initial={rawOf(0, column.col)}
                      onCommit={(value) => commit(0, column.col, value)}
                      onCancel={() => setEditing(null)}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={(event) => {
                        if (event.detail > 1) return;
                        toggleSort(column.col);
                      }}
                      onDoubleClick={() => !loading && setEditing({ row: 0, col: column.col })}
                      title={`Sort by ${column.label}. Double-click to rename`}
                      className={cx(RECORDS_SORT_BUTTON, "w-full gap-1.5")}
                    >
                      {Icon && <RecordsHeaderIcon as={Icon} />}
                      <span className="truncate">{column.label}</span>
                      <RecordsSortMark direction={sort?.col === column.col ? sort.dir : null} />
                    </button>
                  )}
                </th>
              );
            })}
            <th className={cx(RECORDS_HEADER_STICKY, RECORDS_HEADER_CELL, "w-10")}>
              <button
                type="button"
                onClick={addColumn}
                disabled={loading || sheet.colCount >= SHEET_MAX_COLS}
                aria-label="Add column"
                title="Add column"
                className="grid size-6 place-items-center rounded-md text-text-tertiary transition-colors hover:bg-background-secondary-default hover:text-text-primary disabled:opacity-40"
              >
                <RiAddLine aria-hidden className="size-4" />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((record) => (
            <tr key={record.row} className={RECORDS_ROW}>
              {record.cells.map((cell, index) => {
                const column = table.columns[index]!;
                const type = types[index] ?? "text";
                const isEditing = editing?.row === record.row && editing.col === column.col;
                return (
                  <td
                    key={cell.ref}
                    onDoubleClick={() => !loading && setEditing({ row: record.row, col: column.col })}
                    title={cell.error ?? undefined}
                    className={cx(
                      index === 0 && RECORDS_STICKY,
                      RECORDS_CELL,
                      "whitespace-nowrap",
                      type === "number" && "text-right",
                    )}
                  >
                    {isEditing ? (
                      <CellEditor
                        initial={rawOf(record.row, column.col)}
                        onCommit={(value) => commit(record.row, column.col, value)}
                        onCancel={() => setEditing(null)}
                      />
                    ) : index === 0 ? (
                      cell.display.trim() ? (
                        <RecordsNameCell name={cell.display} />
                      ) : (
                        <span className="text-text-tertiary">{" "}</span>
                      )
                    ) : (
                      <TypedCell cell={cell} type={type} tones={tones[index] ?? new Map()} />
                    )}
                  </td>
                );
              })}
              <td className={RECORDS_CELL} />
            </tr>
          ))}
          <tr>
            <td colSpan={table.columns.length + 1} className={cx(RECORDS_STICKY, "px-3 py-1.5")}>
              <button
                type="button"
                onClick={addRow}
                disabled={loading || sheet.rowCount >= SHEET_MAX_ROWS}
                className="inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 text-caption-1-regular text-text-tertiary transition-colors hover:text-text-primary disabled:opacity-40"
              >
                <RiAddLine aria-hidden className="size-3.5" /> New row
              </button>
            </td>
          </tr>
        </tbody>
      </RecordsTableFrame>

      {/* The bottom bar: sort and filter, the sheets as views with their counts, a new view. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => (filters.length === 0 ? addFilter() : setFiltersOpen((open) => !open))}
          aria-expanded={filtersOpen}
          className={cx(
            "inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-caption-1-medium transition-colors hover:bg-background-secondary-default",
            activeFilters > 0 ? "text-text-primary" : "text-text-secondary",
          )}
        >
          <RiFilter3Line aria-hidden className="size-3.5" />
          Sort & filter
          {activeFilters > 0 && <span className="tabular-nums text-text-tertiary">{activeFilters}</span>}
        </button>
        <span className="mx-1 h-4 w-px bg-border-button-default" aria-hidden />
        {workbook.sheets.map((item) => {
          const active = item.id === workbook.activeSheetId;
          return renaming === item.id ? (
            <input
              key={item.id}
              // biome-ignore lint/a11y/noAutofocus: focus the rename field the moment it opens.
              autoFocus
              defaultValue={item.name}
              aria-label={`Rename ${item.name}`}
              onBlur={(event) => {
                onChange(renameSheet(workbook, item.id, event.currentTarget.value));
                setRenaming(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  onChange(renameSheet(workbook, item.id, event.currentTarget.value));
                  setRenaming(null);
                }
                if (event.key === "Escape") setRenaming(null);
              }}
              className="h-7 w-28 rounded-lg border border-foreground-icon-primary bg-background-primary-default px-2 text-caption-1-medium text-text-primary outline-none"
            />
          ) : (
            <button
              key={item.id}
              type="button"
              onClick={() => onChange({ ...workbook, activeSheetId: item.id })}
              onDoubleClick={() => setRenaming(item.id)}
              aria-current={active ? "true" : undefined}
              title={`${item.name}. Double-click to rename`}
              className={cx(
                "inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-caption-1-medium transition-colors",
                active
                  ? "bg-background-secondary-default text-text-primary"
                  : "text-text-secondary hover:bg-background-secondary-default hover:text-text-primary",
              )}
            >
              {item.name}
              <span className="tabular-nums text-text-tertiary">{viewCounts.get(item.id) ?? 0}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => onChange(addSheet(workbook))}
          disabled={loading || workbook.sheets.length >= WORKBOOK_MAX_SHEETS}
          className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-caption-1-medium text-text-secondary transition-colors hover:bg-background-secondary-default hover:text-text-primary disabled:opacity-40"
        >
          <RiAddLine aria-hidden className="size-3.5" /> New view
        </button>
        {capped && (
          <span className="ml-auto text-caption-1-regular text-text-tertiary">
            Large sheet: showing the first {VISIBLE_ROW_CAP} rows and {VISIBLE_COL_CAP} columns.
          </span>
        )}
      </div>

      {filtersOpen && (
        <div className="flex flex-col gap-1.5 rounded-xl border border-border-button-default bg-background-primary-default p-2">
          {filters.map((filter, index) => {
            const type = types[filter.col] ?? "text";
            const ops = filterOps(type);
            const field =
              "h-7 rounded-md border border-border-button-default bg-background-primary-default px-2 text-caption-1-regular text-text-primary outline-none focus:border-foreground-icon-primary";
            const update = (patch: Partial<SheetFilter>) =>
              setFilters((current) => current.map((item, at) => (at === index ? { ...item, ...patch } : item)));
            return (
              <div key={index} className="flex flex-wrap items-center gap-1.5">
                <select
                  aria-label="Filter column"
                  value={filter.col}
                  onChange={(event) => {
                    const col = Number(event.currentTarget.value);
                    update({ col, op: filterOps(types[col] ?? "text")[0]!, value: "" });
                  }}
                  className={field}
                >
                  {table.columns.map((column) => (
                    <option key={column.col} value={column.col}>
                      {column.label}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Filter condition"
                  value={filter.op}
                  onChange={(event) => update({ op: event.currentTarget.value as SheetFilterOp })}
                  className={field}
                >
                  {ops.map((op) => (
                    <option key={op} value={op}>
                      {FILTER_OP_LABELS[op]}
                    </option>
                  ))}
                </select>
                <input
                  type={type === "date" ? "date" : "text"}
                  aria-label="Filter value"
                  value={filter.value}
                  placeholder={type === "date" ? "" : "Value"}
                  onChange={(event) => update({ value: event.currentTarget.value })}
                  className={cx(field, "min-w-32 flex-1")}
                />
                <button
                  type="button"
                  onClick={() => setFilters((current) => current.filter((_, at) => at !== index))}
                  aria-label="Remove filter"
                  className="grid size-7 place-items-center rounded-md text-text-tertiary hover:bg-background-secondary-default hover:text-text-primary"
                >
                  <RiCloseLine aria-hidden className="size-4" />
                </button>
              </div>
            );
          })}
          <div>
            <button
              type="button"
              onClick={addFilter}
              className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-caption-1-medium text-text-secondary hover:text-text-primary"
            >
              <RiAddLine aria-hidden className="size-3.5" /> Add filter
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
