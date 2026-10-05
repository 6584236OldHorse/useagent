import { describe, expect, test } from "bun:test";
import { fileListCommand, MAX_EXAMINED_FILES, parseFileListing } from "./harvest";

describe("fileListCommand", () => {
  test("prunes by name from depth one, prunes repositories by their .git entry, lists deliverables since the turn", () => {
    const command = fileListCommand("/root/work", 1_757_000_000);
    expect(command).toContain("find '/root/work' -xdev \\( -name 'node_modules'");
    expect(command).toContain("-name '.skynet-inputs'");
    expect(command).toContain("! -path '/root/work' -type d -exec test -e '{}/.git' \\; \\) -prune");
    expect(command).toContain("-newermt '@1757000000'");
    expect(command).toContain("-size -52428801c");
    expect(command).toContain("-iname '*.pdf'");
    expect(command).toContain("-printf '%s\\t%T@\\t%p\\0' 2>/dev/null | head -z -n 3000");
  });

  test("quotes a workspace path with a single quote", () => {
    expect(fileListCommand("/root/it's", 1)).toContain("'/root/it'\\''s'");
  });
});

describe("parseFileListing", () => {
  const root = "/root/work";

  test("keeps deliverables under the workspace, newest first, then by path", () => {
    const listing = [
      "1200\t100.5\t/root/work/out/report.pdf",
      "40\t200\t/root/work/notes.md",
      "41\t200\t/root/work/a.md",
      "5\t300\t/elsewhere/leak.pdf",
      "0\t300\t/root/work/empty.pdf",
      "",
    ].join("\0");
    expect(parseFileListing(listing, root)).toEqual([
      { path: "/root/work/a.md", size: 41, modifiedAt: 200 },
      { path: "/root/work/notes.md", size: 40, modifiedAt: 200 },
      { path: "/root/work/out/report.pdf", size: 1200, modifiedAt: 100.5 },
    ]);
  });

  test("a file name cannot forge a record: newlines and tabs are data, not framing", () => {
    expect(parseFileListing("12\t1\t/root/work/a\nb.pdf\0", root)).toEqual([]);
    expect(parseFileListing("7\t1\t/root/work/odd\tname.pdf\0", root)).toEqual([
      { path: "/root/work/odd\tname.pdf", size: 7, modifiedAt: 1 },
    ]);
    expect(parseFileListing("abc\t1\t/root/work/x.pdf\0", root)).toEqual([]);
    expect(parseFileListing("1e3\t1\t/root/work/x.pdf\0", root)).toEqual([]);
    expect(parseFileListing("10\tnow\t/root/work/x.pdf\0", root)).toEqual([]);
    expect(parseFileListing("10\t/root/work/x.pdf\0", root)).toEqual([]);
  });

  test("tolerates an empty listing and caps what is examined", () => {
    expect(parseFileListing("", root)).toEqual([]);
    const many = Array.from({ length: 260 }, (_, i) => `10\t${i}\t/root/work/file-${String(i).padStart(3, "0")}.pdf`).join("\0");
    const parsed = parseFileListing(many, root);
    expect(parsed).toHaveLength(MAX_EXAMINED_FILES);
    expect(parsed[0]?.path).toBe("/root/work/file-259.pdf");
  });
});
