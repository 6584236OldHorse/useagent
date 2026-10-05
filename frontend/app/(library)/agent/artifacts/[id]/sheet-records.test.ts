import { describe, expect, test } from "bun:test";
import { evaluateWorkbook, type Workbook } from "@useagent/artifact-workspace";
import {
  calculate,
  calculationsFor,
  columnTypes,
  filledRecordCount,
  filterRecords,
  inferColumnType,
  sheetRecords,
  sortedRecords,
  statusTones,
  tagColor,
  type SheetRecordCell,
} from "./sheet-records";

const workbook: Workbook = {
  schemaVersion: 2,
  activeSheetId: "s1",
  sheets: [
    {
      id: "s1",
      name: "Pipeline",
      rowCount: 5,
      colCount: 3,
      cells: {
        A1: { v: "Region", fmt: { bold: true } },
        B1: { v: "Pipeline" },
        A2: { v: "APAC" },
        B2: { v: 1200000, fmt: { numFmt: "currency" } },
        A3: { v: "EMEA" },
        B3: { v: 980000 },
        A4: { v: "Total", fmt: { bold: true, color: "#222222", fill: "#ffffff" } },
        B4: { v: 2180000, f: "=SUM(B2:B3)" },
      },
    },
  ],
};

function cells(values: readonly (string | number)[], numeric = false): SheetRecordCell[] {
  return values.map((value, index) => ({
    ref: `B${index + 2}`,
    display: String(value),
    numeric: numeric || typeof value === "number",
    value,
    error: null,
    style: {},
  }));
}

describe("the records grid's view of a sheet", () => {
  test("row 1 names the columns, a blank header keeps its letter, later rows are records", () => {
    const sheet = workbook.sheets[0]!;
    const { columns, records } = sheetRecords(sheet, evaluateWorkbook(workbook));
    expect(columns.map((c) => c.label)).toEqual(["Region", "Pipeline", "C"]);
    expect(columns.map((c) => c.ref)).toEqual(["A1", "B1", "C1"]);
    expect(records.map((r) => r.row)).toEqual([1, 2, 3, 4]);
    expect(records[0]!.cells.map((c) => c.display)).toEqual(["APAC", "$1,200,000.00", ""]);
    expect(records[0]!.cells[1]!.numeric).toBe(true);
    expect(records[2]!.cells[1]!.value).toBe(2180000);
    expect(records[2]!.cells[0]!.style.fontWeight).toBe(600);
    // Colours the workbook carries never reach the grid; the theme owns them.
    expect(records[2]!.cells[0]!.style.color).toBeUndefined();
    expect(records[2]!.cells[0]!.style.background).toBeUndefined();
    expect(filledRecordCount(records)).toBe(3);
  });

  test("sorting is numeric-aware, keeps blanks last, and never touches the sheet", () => {
    const sheet = workbook.sheets[0]!;
    const { records } = sheetRecords(sheet, evaluateWorkbook(workbook));
    const asc = sortedRecords(records, { col: 1, dir: 1 }).map((r) => r.row);
    const desc = sortedRecords(records, { col: 1, dir: -1 }).map((r) => r.row);
    expect(asc).toEqual([2, 1, 3, 4]);
    expect(desc).toEqual([3, 1, 2, 4]);
    expect(sortedRecords(records, null)).toBe(records);
    expect(records.map((r) => r.row)).toEqual([1, 2, 3, 4]);
  });

  test("dates sort by time, not by text", () => {
    const records = ["2026-09-01", "2025-12-31", "2026-01-15"].map((value, index) => ({
      row: index + 1,
      cells: [cells([value])[0]!],
    }));
    expect(sortedRecords(records, { col: 0, dir: 1 }).map((r) => r.row)).toEqual([2, 3, 1]);
  });
});

describe("column types read off the cells", () => {
  test("numbers, dates, links, tags, status, and text", () => {
    expect(inferColumnType(cells([1, 2.5, 3]))).toBe("number");
    expect(inferColumnType(cells(["2026-08-18", "2026-01-02T10:00", ""]))).toBe("date");
    expect(inferColumnType(cells(["aurora-scoops.example.com", "https://x.dev/a", "www.cafe.io"]))).toBe("url");
    expect(inferColumnType(cells(["Gelato, B2B", "Gelato", "Sorbet, Imports", "B2B, Local"]))).toBe("tags");
    const strengths = ["Very strong", "Weak", "Very weak", "Very strong", "Weak", "No communication", "Weak", "Very strong", "Very weak", "Weak", "Very strong"];
    expect(inferColumnType(cells(strengths))).toBe("status");
    expect(inferColumnType(cells(["Alpine Churn", "Amber Scoop", "Andes Snow"]))).toBe("text");
    expect(inferColumnType(cells(["2026-08-18", "soon", 3]))).toBe("text");
    expect(inferColumnType(cells([]))).toBe("text");
  });

  test("a repeated vocabulary without commas is tags below ten rows and status from ten", () => {
    expect(inferColumnType(cells(["Open", "Closed", "Open", "Open"]))).toBe("tags");
    expect(inferColumnType(cells(Array.from({ length: 10 }, (_, i) => (i % 2 ? "Open" : "Closed"))))).toBe("status");
  });

  test("the first column is always the name", () => {
    const columns = [
      { col: 0, label: "Amount", ref: "A1" },
      { col: 1, label: "Paid", ref: "B1" },
    ];
    const records = [1, 2, 3].map((n, index) => ({ row: index + 1, cells: [cells([n])[0]!, cells([n * 2])[0]!] }));
    expect(columnTypes(columns, records)).toEqual(["text", "number"]);
  });

  test("status tones follow an ordinal scale and fall back to neutral", () => {
    const tones = statusTones(["Very strong", "Weak", "No communication", "very weak"]);
    expect(tones.get("very strong")).toBe("strong");
    expect(tones.get("weak")).toBe("weak");
    expect(tones.get("very weak")).toBe("critical");
    expect(tones.get("no communication")).toBe("neutral");
    expect(statusTones(["Draft", "Sent"]).get("draft")).toBe("neutral");
    expect(statusTones(["low", "High"]).get("high")).toBe("strong");
  });

  test("a tag keeps its colour across rows", () => {
    expect(tagColor("Gelato")).toBe(tagColor("gelato"));
    expect(typeof tagColor("B2B")).toBe("string");
  });
});

describe("filters and footer calculations", () => {
  const records = [
    ["Alpine", "Gelato, B2B", "2026-09-08", "Very strong", "https://alpine.example.com", 0.35],
    ["Baltic", "Dairy-free", "2026-08-01", "Weak", "", 0.31],
    ["Cacao", "B2B, Local", "2024-09-01", "Very strong", "cacao.example.com", 0.44],
  ].map((row, index) => ({
    row: index + 1,
    cells: row.map((value, col) => ({
      ...cells([value])[0]!,
      ref: `${"ABCDEF"[col]}${index + 2}`,
      display: col === 5 ? `${Math.round(Number(value) * 100)}%` : String(value),
    })),
  }));

  test("contains, is, before and after", () => {
    expect(filterRecords(records, [{ col: 1, op: "contains", value: "b2b" }]).map((r) => r.row)).toEqual([1, 3]);
    expect(filterRecords(records, [{ col: 3, op: "equals", value: "weak" }]).map((r) => r.row)).toEqual([2]);
    expect(filterRecords(records, [{ col: 2, op: "before", value: "2026-01-01" }]).map((r) => r.row)).toEqual([3]);
    expect(filterRecords(records, [{ col: 2, op: "after", value: "2026-08-15" }]).map((r) => r.row)).toEqual([1]);
    expect(filterRecords(records, [{ col: 1, op: "contains", value: "  " }])).toBe(records);
  });

  test("each type offers its own calculations and formats like its cells", () => {
    expect(calculationsFor("number")[0]).toBe("sum");
    expect(calculationsFor("url")).toContain("links");
    const percents = records.map((r) => r.cells[5]!);
    expect(calculate("average", percents, "number")).toBe("36.7%");
    expect(calculate("max", percents, "number")).toBe("44%");
    expect(calculate("sum", cells(["$1,200,000.00", "$980,000.00"]).map((c, i) => ({ ...c, value: [1200000, 980000][i]!, numeric: true })), "number")).toBe("$2,180,000.00");
    expect(calculate("unique", records.map((r) => r.cells[1]!), "tags")).toBe("4");
    expect(calculate("links", records.map((r) => r.cells[4]!), "url")).toBe("2");
    expect(calculate("max", records.map((r) => r.cells[2]!), "date")).toBe("2026-09-08");
    expect(calculate("filled", records.map((r) => r.cells[4]!), "url")).toBe("2");
    expect(calculate("count", records.map((r) => r.cells[0]!), "text")).toBe("3");
  });
});
