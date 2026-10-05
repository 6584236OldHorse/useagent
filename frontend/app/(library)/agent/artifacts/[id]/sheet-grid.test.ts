import { describe, expect, test } from "bun:test";
import { evaluateWorkbook, type Workbook } from "@useagent/artifact-workspace";
import { sheetRecords, sortedRecords } from "./sheet-grid";

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
        A4: { v: "Total", fmt: { bold: true } },
        B4: { v: 2180000, f: "=SUM(B2:B3)" },
      },
    },
  ],
};

describe("the records table's view of a sheet", () => {
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
});
