import { describe, expect, test } from "bun:test";
import {
  fileListCommand,
  MAX_HARVESTED_FILES,
  parseFileListing,
  parseRepositoryListing,
  repositoryListCommand,
} from "./harvest";

describe("listing commands", () => {
  test("pass one finds nested repositories by their .git entry, directory or file", () => {
    const command = repositoryListCommand("/root/work");
    expect(command).toContain("find '/root/work' -xdev -mindepth 2");
    expect(command).toContain("-name .git -printf '%h\\0' -prune");
    expect(command).toContain("head -z");
  });

  test("pass two prunes dependency trees, upload staging and the repositories pass one found", () => {
    const command = fileListCommand("/root/work", 1_757_000_000, ["/root/work/repo"]);
    expect(command).toContain("-newermt '@1757000000'");
    expect(command).toContain("-name '.skynet-inputs'");
    expect(command).toContain("-path '/root/work/repo'");
    expect(command).toContain("-iname '*.pdf'");
    expect(command).toContain("-printf '%s\\t%p\\0'");
    expect(command).toContain("-size -52428801c");
  });

  test("quotes a workspace path with a single quote", () => {
    expect(fileListCommand("/root/it's", 1, [])).toContain("'/root/it'\\''s'");
  });
});

describe("parseRepositoryListing", () => {
  test("keeps roots strictly below the workspace", () => {
    expect(parseRepositoryListing("/root/work/b\0/root/work/a\0/elsewhere\0/root/work\0", "/root/work")).toEqual([
      "/root/work/a",
      "/root/work/b",
    ]);
  });
});

describe("parseFileListing", () => {
  const root = "/root/work";

  test("keeps deliverables under the workspace and drops files inside repositories", () => {
    const listing = [
      "1200\t/root/work/out/report.pdf",
      "40\t/root/work/notes.md",
      "9\t/root/work/deep/repo/docs/design.md",
      "5\t/elsewhere/leak.pdf",
      "0\t/root/work/empty.pdf",
      "",
    ].join("\0");
    expect(parseFileListing(listing, root, ["/root/work/deep/repo"])).toEqual([
      { path: "/root/work/notes.md", size: 40 },
      { path: "/root/work/out/report.pdf", size: 1200 },
    ]);
  });

  test("a file name cannot forge a record: newlines and tabs are data, not framing", () => {
    const tricky = "12\t/root/work/a\n--repos--\n/root/work/repo\0";
    expect(parseFileListing(tricky, root, ["/root/work/repo"])).toEqual([]);
    const withTab = "7\t/root/work/odd\tname.pdf\0";
    expect(parseFileListing(withTab, root, [])).toEqual([{ path: "/root/work/odd\tname.pdf", size: 7 }]);
    expect(parseFileListing("abc\t/root/work/x.pdf\0", root, [])).toEqual([]);
  });

  test("tolerates an empty listing and caps the batch", () => {
    expect(parseFileListing("", root, [])).toEqual([]);
    const many = Array.from({ length: 60 }, (_, i) => `10\t/root/work/file-${String(i).padStart(2, "0")}.pdf`).join("\0");
    expect(parseFileListing(many, root, [])).toHaveLength(MAX_HARVESTED_FILES);
  });
});
