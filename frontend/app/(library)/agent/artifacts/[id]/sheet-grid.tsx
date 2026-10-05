"use client";

// The spreadsheet editor over the canonical v2 workbook. The active sheet renders
// through the AI kit's records table (components/ai/records-table.tsx): row 1
// names the columns, every later row is a record, headers sort, the footer counts.
// Around it: a value bar that shows the RAW formula while the cell shows the
// computed value (single-click a cell to select it, double-click to edit it in
// the bar), a number-format + styling toolbar, and multi-sheet tabs (add / rename
// / reorder). Cell fill/text colors are DOCUMENT data, so they apply as raw inline
// styles; the surrounding chrome uses semantic tokens. The visible grid is capped
// (windowed) so a 10000-row sheet never renders raw.

import {
  RiAddLine,
  RiArrowLeftSLine,
  RiArrowRightSLine,
  RiBold,
  RiItalic,
} from "@remixicon/react";
import {
  activeWorksheet,
  columnLabel,
  evaluateWorkbook,
  formatA1,
  parseA1,
  SHEET_MAX_COLS,
  SHEET_MAX_ROWS,
  WORKBOOK_MAX_SHEETS,
  type SheetCell,
  type SheetCellFormat,
  type SheetNumberFormat,
  type Workbook,
  type Worksheet,
} from "@useagent/artifact-workspace";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  RECORDS_CELL,
  RECORDS_HEADER_CELL,
  RECORDS_ROW,
  RECORDS_SORT_BUTTON,
  RECORDS_STICKY,
  RecordsNameCell,
  RecordsSortMark,
  RecordsTableFrame,
} from "@/components/ai/records-table";
import { cx } from "@/utils/cx";

/** Visible grid caps so a large sheet windows honestly instead of rendering raw. */
const VISIBLE_ROW_CAP = 200;
const VISIBLE_COL_CAP = 40;

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

/** Apply a format patch to a cell (creating an empty cell to hold it if needed);
 * clearing a key (undefined/false/"") drops it, matching the block inspector. */
export function applyCellFormat(
  workbook: Workbook,
  sheetId: string,
  ref: string,
  patch: Partial<SheetCellFormat>,
): Workbook {
  const position = parseA1(ref);
  const sheet = workbook.sheets.find((item) => item.id === sheetId);
  if (!position || !sheet) return workbook;
  const existing = sheet.cells[ref];
  const fmt: Record<string, unknown> = { ...existing?.fmt };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === false || value === "") delete fmt[key];
    else fmt[key] = value;
  }
  const nextFmt = Object.keys(fmt).length > 0 ? (fmt as SheetCellFormat) : undefined;
  const cell: SheetCell = existing
    ? { ...existing, ...(nextFmt ? { fmt: nextFmt } : {}) }
    : { v: "", ...(nextFmt ? { fmt: nextFmt } : {}) };
  if (!nextFmt && "fmt" in cell) delete (cell as { fmt?: unknown }).fmt;
  // Drop a now-empty, unformatted cell entirely.
  const cells = { ...sheet.cells };
  if (cell.v === "" && cell.f === undefined && !nextFmt) delete cells[ref];
  else cells[ref] = cell;
  return replaceSheet(workbook, grownDimensions({ ...sheet, cells }, position.row, position.col));
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

function moveSheet(workbook: Workbook, sheetId: string, delta: number): Workbook {
  const index = workbook.sheets.findIndex((sheet) => sheet.id === sheetId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= workbook.sheets.length) return workbook;
  const sheets = [...workbook.sheets];
  const moved = sheets[index]!;
  sheets[index] = sheets[target]!;
  sheets[target] = moved;
  return { ...workbook, sheets };
}

// --- UI --------------------------------------------------------------------

const NUMBER_FORMATS: readonly (readonly [SheetNumberFormat, string, string])[] = [
  ["auto", "Auto", "123"],
  ["currency", "Currency", "$"],
  ["percent", "Percent", "%"],
  ["0", "Integer", ".0"],
  ["0.00", "Two decimals", ".00"],
];

function toColorInput(hex: string | undefined, fallback: string): string {
  if (!hex) return fallback;
  const raw = hex.replace(/^#/, "");
  const six = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw.slice(0, 6);
  return /^[0-9a-fA-F]{6}$/.test(six) ? `#${six}` : fallback;
}

function cellStyle(cell: SheetCell | undefined, numeric: boolean): CSSProperties {
  const fmt = cell?.fmt;
  return {
    fontWeight: fmt?.bold ? 600 : undefined,
    fontStyle: fmt?.italic ? "italic" : undefined,
    textAlign: fmt?.align ?? (numeric ? "right" : "left"),
    ...(fmt?.color ? { color: fmt.color } : {}),
    ...(fmt?.fill ? { background: fmt.fill } : {}),
  };
}

// --- The records table's view of a sheet ------------------------------------

type WorkbookEvaluation = ReturnType<typeof evaluateWorkbook>;

export interface SheetRecordCell {
  readonly ref: string;
  readonly display: string;
  readonly numeric: boolean;
  /** The computed scalar, for numeric-aware sorting; null when empty or an error. */
  readonly value: string | number | boolean | null;
  readonly error: string | null;
  readonly style: CSSProperties;
}

export interface SheetRecord {
  /** The sheet row (zero-based), so a click still selects the real cell. */
  readonly row: number;
  readonly cells: readonly SheetRecordCell[];
}

export interface SheetRecordColumn {
  readonly col: number;
  /** Row 1's value, or the column letter when row 1 leaves it blank. */
  readonly label: string;
  readonly ref: string;
}

/** Row 1 names the columns and every later row is a record, the way the records
 *  table reads a sheet. Windowed to the visible caps. */
export function sheetRecords(
  sheet: Worksheet,
  evaluation: WorkbookEvaluation,
): { readonly columns: readonly SheetRecordColumn[]; readonly records: readonly SheetRecord[] } {
  const colCount = Math.min(VISIBLE_COL_CAP, Math.max(1, sheet.colCount));
  const rowCount = Math.min(VISIBLE_ROW_CAP, sheet.rowCount);
  const columns = Array.from({ length: colCount }, (_, col) => {
    const ref = formatA1(0, col);
    const display = evaluation.cell(sheet.id, ref).display.trim();
    return { col, label: display || columnLabel(col), ref };
  });
  const records = Array.from({ length: Math.max(0, rowCount - 1) }, (_, index) => {
    const row = index + 1;
    return {
      row,
      cells: columns.map(({ col }) => {
        const ref = formatA1(row, col);
        const evaluated = evaluation.cell(sheet.id, ref);
        return {
          ref,
          display: evaluated.display,
          numeric: evaluated.numeric,
          value: evaluated.error ? null : evaluated.value,
          error: evaluated.error,
          style: cellStyle(sheet.cells[ref], evaluated.numeric),
        };
      }),
    };
  });
  return { columns, records };
}

export interface SheetSort {
  readonly col: number;
  readonly dir: 1 | -1;
}

/** Records in column order: numbers before text, blanks last, ties by row. */
export function sortedRecords(records: readonly SheetRecord[], sort: SheetSort | null): readonly SheetRecord[] {
  if (!sort) return records;
  const rank = (cell: SheetRecordCell | undefined): [number, number | string] => {
    if (!cell || cell.value === null || cell.display === "") return [2, ""];
    if (typeof cell.value === "number") return [0, cell.value];
    return [1, cell.display];
  };
  return records.toSorted((a, b) => {
    const [ka, va] = rank(a.cells[sort.col]);
    const [kb, vb] = rank(b.cells[sort.col]);
    if (ka !== kb) return ka - kb;
    const order = typeof va === "number" && typeof vb === "number"
      ? va - vb
      : String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: "base" });
    return (order || a.row - b.row) * (ka === 2 ? 1 : sort.dir);
  });
}

export function SheetGridSurface({
  workbook,
  loading,
  onChange,
}: {
  readonly workbook: Workbook | null;
  readonly loading: boolean;
  readonly onChange: (workbook: Workbook) => void;
}) {
  const [selected, setSelected] = useState<{ row: number; col: number }>({ row: 0, col: 0 });
  const [draft, setDraft] = useState("");
  const [editingBar, setEditingBar] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [sort, setSort] = useState<SheetSort | null>(null);
  const barRef = useRef<HTMLInputElement>(null);

  const sheet = workbook ? activeWorksheet(workbook) : null;
  const evaluation = useMemo(() => (workbook ? evaluateWorkbook(workbook) : null), [workbook]);
  const table = useMemo(() => (sheet && evaluation ? sheetRecords(sheet, evaluation) : null), [sheet, evaluation]);
  const records = useMemo(() => (table ? sortedRecords(table.records, sort) : []), [table, sort]);

  const selectedRef = sheet ? formatA1(selected.row, selected.col) : "A1";
  const selectedCell = sheet?.cells[selectedRef];
  const rawOfSelected = selectedCell?.f ?? (selectedCell ? String(selectedCell.v) : "");

  // Keep the value bar in sync with the selected cell unless it is being edited.
  useEffect(() => {
    if (!editingBar) setDraft(rawOfSelected);
  }, [rawOfSelected, editingBar]);

  if (!workbook || !sheet || !evaluation || !table) {
    return (
      <p className="mt-4 rounded-xl border border-dashed border-border-button-default px-4 py-8 text-center text-body-2-regular text-text-secondary">
        Loading workbook...
      </p>
    );
  }

  const capped = sheet.rowCount > VISIBLE_ROW_CAP || sheet.colCount > VISIBLE_COL_CAP;

  const commitBar = () => {
    onChange(commitCell(workbook, sheet.id, selectedRef, draft));
    setEditingBar(false);
  };
  const patchFmt = (patch: Partial<SheetCellFormat>) =>
    onChange(applyCellFormat(workbook, sheet.id, selectedRef, patch));

  const select = (row: number, col: number) => setSelected({ row, col });
  const edit = (row: number, col: number) => {
    setSelected({ row, col });
    barRef.current?.focus();
  };
  const toggleSort = (col: number) =>
    setSort((current) => (current?.col === col ? { col, dir: current.dir === 1 ? -1 : 1 } : { col, dir: 1 }));

  const fmt = selectedCell?.fmt;

  return (
    <section className="mt-4 flex h-full min-h-0 flex-1 flex-col gap-3">
      {/* Value bar: active cell ref + its RAW value/formula (the cell shows the
          computed value). */}
      <div className="flex items-center gap-2">
        <span className="inline-flex h-8 min-w-14 items-center justify-center rounded-lg border border-border-button-default bg-background-secondary-default px-2 font-mono text-caption-1-medium text-text-secondary">
          {selectedRef}
        </span>
        <span className="font-mono text-caption-1-medium text-text-tertiary" aria-hidden>
          fx
        </span>
        <input
          ref={barRef}
          value={draft}
          disabled={loading}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setEditingBar(true);
          }}
          onFocus={() => setEditingBar(true)}
          onBlur={commitBar}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitBar();
              setSelected((current) => ({
                row: Math.min(SHEET_MAX_ROWS - 1, current.row + 1),
                col: current.col,
              }));
            }
            if (event.key === "Escape") {
              setEditingBar(false);
              setDraft(rawOfSelected);
            }
          }}
          aria-label={`Value of cell ${selectedRef}`}
          placeholder="Value or =formula"
          className="h-8 min-w-0 flex-1 rounded-lg border border-border-button-default bg-background-primary-default px-3 font-mono text-body-2-regular text-text-primary outline-none focus:border-foreground-icon-primary"
        />
      </div>

      {/* Format toolbar: number formats, bold/italic, alignment, fill + text color. */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="inline-flex items-center rounded-lg border border-border-button-default p-0.5">
          {NUMBER_FORMATS.map(([value, title, glyph]) => (
            <button
              key={value}
              type="button"
              title={title}
              aria-label={title}
              aria-pressed={(fmt?.numFmt ?? "auto") === value}
              disabled={loading}
              onClick={() => patchFmt({ numFmt: value === "auto" ? undefined : value })}
              className="grid h-7 min-w-8 place-items-center rounded-md px-1.5 font-mono text-caption-1-medium text-text-secondary hover:bg-background-secondary-default aria-pressed:bg-foreground-icon-primary aria-pressed:text-background-full disabled:opacity-40"
            >
              {glyph}
            </button>
          ))}
        </div>
        <div className="mx-0.5 h-5 w-px bg-border-button-default" aria-hidden />
        <button
          type="button"
          title="Bold"
          aria-label="Bold"
          aria-pressed={fmt?.bold ?? false}
          disabled={loading}
          onClick={() => patchFmt({ bold: !(fmt?.bold ?? false) })}
          className="grid size-8 place-items-center rounded-lg border border-border-button-default text-text-secondary hover:bg-background-secondary-default aria-pressed:bg-foreground-icon-primary aria-pressed:text-background-full disabled:opacity-40"
        >
          <RiBold aria-hidden className="size-4" />
        </button>
        <button
          type="button"
          title="Italic"
          aria-label="Italic"
          aria-pressed={fmt?.italic ?? false}
          disabled={loading}
          onClick={() => patchFmt({ italic: !(fmt?.italic ?? false) })}
          className="grid size-8 place-items-center rounded-lg border border-border-button-default text-text-secondary hover:bg-background-secondary-default aria-pressed:bg-foreground-icon-primary aria-pressed:text-background-full disabled:opacity-40"
        >
          <RiItalic aria-hidden className="size-4" />
        </button>
        <div className="inline-flex items-center rounded-lg border border-border-button-default p-0.5">
          {(["left", "center", "right"] as const).map((align) => (
            <button
              key={align}
              type="button"
              title={`Align ${align}`}
              aria-label={`Align ${align}`}
              aria-pressed={fmt?.align === align}
              disabled={loading}
              onClick={() => patchFmt({ align: fmt?.align === align ? undefined : align })}
              className="grid h-7 min-w-7 place-items-center rounded-md text-caption-1-medium text-text-secondary hover:bg-background-secondary-default aria-pressed:bg-foreground-icon-primary aria-pressed:text-background-full disabled:opacity-40"
            >
              {align === "left" ? "L" : align === "center" ? "C" : "R"}
            </button>
          ))}
        </div>
        <label className="inline-flex items-center gap-1 text-caption-1-medium text-text-secondary">
          Fill
          <input
            type="color"
            aria-label="Cell fill color"
            value={toColorInput(fmt?.fill, "#ffffff")}
            disabled={loading}
            onChange={(event) => patchFmt({ fill: event.currentTarget.value })}
            className="h-7 w-8 cursor-pointer rounded border border-border-button-default bg-background-primary-default"
          />
        </label>
        <label className="inline-flex items-center gap-1 text-caption-1-medium text-text-secondary">
          Text
          <input
            type="color"
            aria-label="Cell text color"
            value={toColorInput(fmt?.color, "#000000")}
            disabled={loading}
            onChange={(event) => patchFmt({ color: event.currentTarget.value })}
            className="h-7 w-8 cursor-pointer rounded border border-border-button-default bg-background-primary-default"
          />
        </label>
      </div>

      {/* The sheet through the records table: row 1 as the header (click sorts,
          double-click edits it in the bar), later rows as records, the count in
          the footer. Cell fill/text colors are the document's own. */}
      <RecordsTableFrame count={records.length} columns={Math.max(0, table.columns.length - 1)} fill>
        <thead>
          <tr className="border-border-button-default border-b">
            {table.columns.map((column, index) => {
              const active = selected.row === 0 && selected.col === column.col;
              return (
                <th
                  key={column.col}
                  aria-sort={sort?.col === column.col ? (sort.dir === 1 ? "ascending" : "descending") : undefined}
                  className={cx(
                    index === 0 && cx(RECORDS_STICKY, "bg-background-primary-default"),
                    RECORDS_HEADER_CELL,
                    active && "ring-2 ring-inset ring-border-focus-ring",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => toggleSort(column.col)}
                    onDoubleClick={() => edit(0, column.col)}
                    title={`Sort by ${column.label}. Double-click to edit ${column.ref}`}
                    className={cx(RECORDS_SORT_BUTTON, "w-full")}
                  >
                    <span className="truncate">{column.label}</span>
                    <RecordsSortMark direction={sort?.col === column.col ? sort.dir : null} />
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.row} className={RECORDS_ROW}>
              {record.cells.map((cell, index) => {
                const column = table.columns[index]!;
                const active = selected.row === record.row && selected.col === column.col;
                const numeric = cell.numeric && index > 0;
                return (
                  <td
                    key={cell.ref}
                    className={cx(
                      index === 0 && RECORDS_STICKY,
                      RECORDS_CELL,
                      active && "ring-2 ring-inset ring-border-focus-ring",
                    )}
                    style={cell.style.background ? { background: cell.style.background } : undefined}
                  >
                    <button
                      type="button"
                      onClick={() => select(record.row, column.col)}
                      onDoubleClick={() => edit(record.row, column.col)}
                      title={cell.error ?? `${cell.ref}. Double-click to edit`}
                      style={{ ...cell.style, background: undefined }}
                      className={cx(
                        "block w-full min-w-0 truncate outline-none",
                        index === 0
                          ? "text-left"
                          : cx(
                              "text-caption-1-regular text-text-secondary",
                              numeric ? "text-right tabular-nums" : "text-left",
                            ),
                        cell.error && "text-text-error-primary",
                      )}
                    >
                      {index === 0 ? <RecordsNameCell name={cell.display} /> : cell.display || "\u00a0"}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </RecordsTableFrame>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() =>
            onChange(
              replaceSheet(
                workbook,
                grownDimensions(sheet, Math.min(SHEET_MAX_ROWS - 1, sheet.rowCount), sheet.colCount - 1),
              ),
            )}
          disabled={loading || sheet.rowCount >= SHEET_MAX_ROWS}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-button-default px-3 text-body-2-medium hover:bg-background-secondary-default disabled:opacity-40"
        >
          <RiAddLine aria-hidden className="size-4" /> Row
        </button>
        <button
          type="button"
          onClick={() =>
            onChange(
              replaceSheet(
                workbook,
                grownDimensions(sheet, sheet.rowCount - 1, Math.min(SHEET_MAX_COLS - 1, sheet.colCount)),
              ),
            )}
          disabled={loading || sheet.colCount >= SHEET_MAX_COLS}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-button-default px-3 text-body-2-medium hover:bg-background-secondary-default disabled:opacity-40"
        >
          <RiAddLine aria-hidden className="size-4" /> Column
        </button>
        {capped && (
          <span className="text-caption-1-regular text-text-tertiary">
            Large sheet - showing the first {VISIBLE_ROW_CAP} rows and {VISIBLE_COL_CAP} columns.
          </span>
        )}
      </div>

      {/* Sheet tabs: add / rename (double-click) / reorder / switch. */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1">
        {workbook.sheets.map((item) => {
          const active = item.id === workbook.activeSheetId;
          return (
            <div key={item.id} className="flex shrink-0 items-center">
              {renaming === item.id ? (
                <input
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
                  type="button"
                  onClick={() => onChange({ ...workbook, activeSheetId: item.id })}
                  onDoubleClick={() => setRenaming(item.id)}
                  aria-current={active}
                  title={`${item.name} (double-click to rename)`}
                  className={
                    active
                      ? "inline-flex h-7 items-center rounded-lg border border-border-button-default bg-foreground-icon-primary px-3 text-caption-1-medium text-background-full"
                      : "inline-flex h-7 items-center rounded-lg border border-border-button-default bg-background-secondary-default px-3 text-caption-1-medium text-text-secondary hover:text-text-primary"
                  }
                >
                  {item.name}
                </button>
              )}
              {active && workbook.sheets.length > 1 && (
                <span className="ml-0.5 flex items-center">
                  <button
                    type="button"
                    onClick={() => onChange(moveSheet(workbook, item.id, -1))}
                    aria-label={`Move ${item.name} left`}
                    title="Move left"
                    className="grid size-6 place-items-center rounded text-text-tertiary hover:bg-background-secondary-default hover:text-text-primary"
                  >
                    <RiArrowLeftSLine aria-hidden className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange(moveSheet(workbook, item.id, 1))}
                    aria-label={`Move ${item.name} right`}
                    title="Move right"
                    className="grid size-6 place-items-center rounded text-text-tertiary hover:bg-background-secondary-default hover:text-text-primary"
                  >
                    <RiArrowRightSLine aria-hidden className="size-4" />
                  </button>
                </span>
              )}
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => onChange(addSheet(workbook))}
          disabled={loading || workbook.sheets.length >= WORKBOOK_MAX_SHEETS}
          aria-label="Add sheet"
          title="Add sheet"
          className="grid size-7 shrink-0 place-items-center rounded-lg border border-border-button-default text-text-secondary hover:bg-background-secondary-default disabled:opacity-40"
        >
          <RiAddLine aria-hidden className="size-4" />
        </button>
      </div>
    </section>
  );
}
