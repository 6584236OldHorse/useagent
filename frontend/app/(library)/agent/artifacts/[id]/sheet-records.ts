// The records grid's view of a worksheet: row 1 names the columns, every later
// row is a record, and each column gets a type read off its cells (date, number,
// link, tags, status, text) so the grid draws chips, relative dates, tone dots
// and links the way the records table does. Pure and DOM-free so it tests
// without React; the workbook itself is never changed here.

import { columnLabel, type evaluateWorkbook, formatA1, type Worksheet } from "@useagent/artifact-workspace";
import type { CSSProperties } from "react";
import type { RecordTagColor, StrengthTone } from "@/components/ai/records-table";

/** Visible grid caps so a large sheet windows honestly instead of rendering raw. */
export const VISIBLE_ROW_CAP = 200;
export const VISIBLE_COL_CAP = 40;

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
  /** The sheet row (zero-based), so a click still edits the real cell. */
  readonly row: number;
  readonly cells: readonly SheetRecordCell[];
}

export interface SheetRecordColumn {
  readonly col: number;
  /** Row 1's value, or the column letter when row 1 leaves it blank. */
  readonly label: string;
  readonly ref: string;
}

function cellStyle(sheet: Worksheet, ref: string, numeric: boolean): CSSProperties {
  const fmt = sheet.cells[ref]?.fmt;
  return {
    fontWeight: fmt?.bold ? 600 : undefined,
    fontStyle: fmt?.italic ? "italic" : undefined,
    textAlign: fmt?.align ?? (numeric ? "right" : "left"),
    ...(fmt?.color ? { color: fmt.color } : {}),
    ...(fmt?.fill ? { background: fmt.fill } : {}),
  };
}

/** Row 1 names the columns and every later row is a record. Windowed to the
 *  visible caps. */
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
          style: cellStyle(sheet, ref, evaluated.numeric),
        };
      }),
    };
  });
  return { columns, records };
}

/** Records with at least one filled cell: what a view chip counts. */
export function filledRecordCount(records: readonly SheetRecord[]): number {
  return records.filter((record) => record.cells.some((cell) => cell.display !== "")).length;
}

// --- Column types -----------------------------------------------------------

export type SheetColumnType = "text" | "number" | "date" | "url" | "tags" | "status";

const URL_LIKE = /^(https?:\/\/\S+|(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?)$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const SHORT_PHRASE_CHARS = 24;
const SHORT_PHRASE_WORDS = 3;
const STATUS_MAX_DISTINCT = 5;
const STATUS_MIN_ROWS = 10;
const TAGS_MAX_DISTINCT = 12;

function shortPhrase(text: string): boolean {
  return text.length > 0 && text.length <= SHORT_PHRASE_CHARS && text.split(/\s+/).length <= SHORT_PHRASE_WORDS;
}

export function parseDate(display: string): number | null {
  if (!ISO_DATE.test(display.trim())) return null;
  const ms = Date.parse(display.trim());
  return Number.isFinite(ms) ? ms : null;
}

export function splitTags(display: string): string[] {
  return display.split(",").map((piece) => piece.trim()).filter(Boolean);
}

/** The type a column's filled cells agree on; text when they agree on nothing.
 *  The first column is always the record's name and never typed. */
export function inferColumnType(cells: readonly SheetRecordCell[]): SheetColumnType {
  const filled = cells.filter((cell) => cell.display.trim() !== "" && !cell.error);
  if (filled.length === 0) return "text";
  if (filled.every((cell) => cell.numeric)) return "number";
  const texts = filled.map((cell) => cell.display.trim());
  if (texts.every((text) => parseDate(text) !== null)) return "date";
  if (texts.every((text) => URL_LIKE.test(text) && !/\s/.test(text))) return "url";
  const distinct = new Set(texts.map((text) => text.toLowerCase()));
  const hasComma = texts.some((text) => text.includes(","));
  if (
    !hasComma &&
    filled.length >= STATUS_MIN_ROWS &&
    distinct.size <= STATUS_MAX_DISTINCT &&
    texts.every(shortPhrase)
  ) {
    return "status";
  }
  const pieces = texts.flatMap(splitTags);
  const vocabulary = new Set(pieces.map((piece) => piece.toLowerCase()));
  if (
    pieces.length > 0 &&
    pieces.every(shortPhrase) &&
    vocabulary.size <= TAGS_MAX_DISTINCT &&
    (hasComma || vocabulary.size < filled.length)
  ) {
    return "tags";
  }
  return "text";
}

export function columnTypes(
  columns: readonly SheetRecordColumn[],
  records: readonly SheetRecord[],
): readonly SheetColumnType[] {
  return columns.map((_, index) =>
    index === 0 ? "text" : inferColumnType(records.map((record) => record.cells[index]!)),
  );
}

const TAG_PALETTE: readonly RecordTagColor[] = [
  "purple",
  "pink",
  "blue",
  "green",
  "orange",
  "teal",
  "sky",
  "yellow",
  "red",
];

/** A stable colour per tag label, so "Gelato" is the same colour in every row. */
export function tagColor(label: string): RecordTagColor {
  let hash = 0;
  for (const char of label.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TAG_PALETTE[hash % TAG_PALETTE.length]!;
}

/** Ordinal vocabularies a status column may use, worst first. Values outside
 *  every scale keep a neutral dot. */
const STATUS_SCALES: readonly (readonly (readonly [string, StrengthTone])[])[] = [
  [
    ["no communication", "neutral"],
    ["none", "neutral"],
    ["very weak", "critical"],
    ["weak", "weak"],
    ["moderate", "neutral"],
    ["strong", "strong"],
    ["very strong", "strong"],
  ],
  [
    ["low", "weak"],
    ["medium", "neutral"],
    ["high", "strong"],
  ],
  [
    ["no", "weak"],
    ["yes", "strong"],
  ],
];

/** Tone per status value when the column's values all belong to one scale. */
export function statusTones(values: readonly string[]): ReadonlyMap<string, StrengthTone> {
  const distinct = [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
  const tones = new Map<string, StrengthTone>();
  const scale = STATUS_SCALES.find((candidate) => distinct.every((value) => candidate.some(([name]) => name === value)));
  for (const value of distinct) {
    tones.set(value, scale?.find(([name]) => name === value)?.[1] ?? "neutral");
  }
  return tones;
}

export function statusTone(display: string, tones: ReadonlyMap<string, StrengthTone>): StrengthTone {
  return tones.get(display.trim().toLowerCase()) ?? "neutral";
}

export function linkHref(display: string): string {
  const text = display.trim();
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

// --- Sorting and filtering ----------------------------------------------------

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
    const date = parseDate(cell.display);
    if (date !== null) return [0, date];
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

export type SheetFilterOp = "contains" | "equals" | "before" | "after";

export interface SheetFilter {
  readonly col: number;
  readonly op: SheetFilterOp;
  readonly value: string;
}

/** The operators a column's type offers. */
export function filterOps(type: SheetColumnType): readonly SheetFilterOp[] {
  switch (type) {
    case "date":
      return ["after", "before"];
    case "status":
      return ["equals", "contains"];
    default:
      return ["contains", "equals"];
  }
}

export function filterRecords(records: readonly SheetRecord[], filters: readonly SheetFilter[]): readonly SheetRecord[] {
  const active = filters.filter((filter) => filter.value.trim() !== "");
  if (active.length === 0) return records;
  return records.filter((record) =>
    active.every((filter) => {
      const display = record.cells[filter.col]?.display ?? "";
      const needle = filter.value.trim().toLowerCase();
      switch (filter.op) {
        case "contains":
          return display.toLowerCase().includes(needle);
        case "equals":
          return display.trim().toLowerCase() === needle;
        case "before":
        case "after": {
          const cell = parseDate(display);
          const bound = parseDate(filter.value);
          if (cell === null || bound === null) return false;
          return filter.op === "before" ? cell < bound : cell > bound;
        }
        default:
          return true;
      }
    }),
  );
}

// --- Footer calculations -------------------------------------------------------

export type SheetCalculation = "count" | "filled" | "unique" | "sum" | "average" | "min" | "max" | "links";

export const CALCULATION_LABELS: Record<SheetCalculation, string> = {
  count: "Count",
  filled: "Filled",
  unique: "Unique",
  sum: "Sum",
  average: "Average",
  min: "Min",
  max: "Max",
  links: "Links",
};

/** The calculations a column's type can answer. */
export function calculationsFor(type: SheetColumnType): readonly SheetCalculation[] {
  switch (type) {
    case "number":
      return ["sum", "average", "min", "max", "count", "filled", "unique"];
    case "date":
      return ["min", "max", "count", "filled", "unique"];
    case "url":
      return ["links", "count", "filled"];
    case "tags":
      return ["unique", "count", "filled"];
    default:
      return ["count", "filled", "unique"];
  }
}

function formatLike(sample: string, numeric: number): string {
  const text = sample.trim();
  if (text.startsWith("$") || text.startsWith("-$")) {
    const body = Math.abs(numeric).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${numeric < 0 ? "-" : ""}$${body}`;
  }
  if (text.endsWith("%")) return `${Math.round(numeric * 10) / 10}%`;
  return Number.isInteger(numeric) ? numeric.toLocaleString("en-US") : (Math.round(numeric * 100) / 100).toLocaleString("en-US");
}

/** One calculation over a column's cells, as the footer shows it. */
export function calculate(
  calculation: SheetCalculation,
  cells: readonly SheetRecordCell[],
  type: SheetColumnType,
): string {
  const filled = cells.filter((cell) => cell.display.trim() !== "" && !cell.error);
  switch (calculation) {
    case "count":
      return String(cells.length);
    case "filled":
      return String(filled.length);
    case "links":
      return String(filled.length);
    case "unique": {
      const values = type === "tags"
        ? filled.flatMap((cell) => splitTags(cell.display))
        : filled.map((cell) => cell.display.trim());
      return String(new Set(values.map((value) => value.toLowerCase())).size);
    }
    case "sum":
    case "average":
    case "min":
    case "max": {
      if (type === "date") {
        const dates = filled.map((cell) => parseDate(cell.display)).filter((ms): ms is number => ms !== null);
        if (dates.length === 0) return "-";
        const pick = calculation === "min" ? Math.min(...dates) : Math.max(...dates);
        return new Date(pick).toISOString().slice(0, 10);
      }
      const numbers = filled.map((cell) => cell.value).filter((value): value is number => typeof value === "number");
      if (numbers.length === 0) return "-";
      const sample = filled.find((cell) => typeof cell.value === "number")?.display ?? "";
      const percent = sample.trim().endsWith("%");
      const scale = (value: number) => (percent ? value * 100 : value);
      switch (calculation) {
        case "sum":
          return formatLike(sample, scale(numbers.reduce((total, value) => total + value, 0)));
        case "average":
          return formatLike(sample, scale(numbers.reduce((total, value) => total + value, 0) / numbers.length));
        case "min":
          return formatLike(sample, scale(Math.min(...numbers)));
        default:
          return formatLike(sample, scale(Math.max(...numbers)));
      }
    }
  }
}
