import { describe, expect, test } from "bun:test";
import { harvestListCommand, MAX_HARVESTED_FILES, parseHarvestListing } from "./harvest";

describe("harvestListCommand", () => {
  test("walks the workspace for deliverables changed since the turn started", () => {
    const command = harvestListCommand("/root/work", 1_757_000_000);
    expect(command).toContain("find '/root/work' -xdev");
    expect(command).toContain("-newermt '@1757000000'");
    expect(command).toContain("-iname '*.pdf'");
    expect(command).toContain("-name 'node_modules'");
    expect(command).toContain("-name '.git'");
    expect(command).toContain("--repos--");
  });

  test("quotes a workspace path with a single quote", () => {
    expect(harvestListCommand("/root/it's", 1)).toContain("'/root/it'\\''s'");
  });
});

describe("parseHarvestListing", () => {
  const root = "/root/work";

  test("keeps deliverables under the workspace and drops files inside nested repositories", () => {
    const listing = [
      "1200\t/root/work/out/report.pdf",
      "40\t/root/work/notes.md",
      "9\t/root/work/repo/docs/design.md",
      "5\t/elsewhere/leak.pdf",
      "0\t/root/work/empty.pdf",
      "",
      "--repos--",
      "/root/work/repo",
    ].join("\n");
    expect(parseHarvestListing(listing, root)).toEqual([
      { path: "/root/work/notes.md", size: 40 },
      { path: "/root/work/out/report.pdf", size: 1200 },
    ]);
  });

  test("tolerates an empty listing and caps the batch", () => {
    expect(parseHarvestListing("", root)).toEqual([]);
    expect(parseHarvestListing("\n--repos--\n", root)).toEqual([]);
    const many = Array.from({ length: 60 }, (_, i) => `10\t/root/work/file-${String(i).padStart(2, "0")}.pdf`).join("\n");
    expect(parseHarvestListing(many, root)).toHaveLength(MAX_HARVESTED_FILES);
  });

  test("never trusts a path with a tab in its size column", () => {
    expect(parseHarvestListing("abc\t/root/work/x.pdf", root)).toEqual([]);
  });
});
