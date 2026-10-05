import { describe, expect, test } from "bun:test";
import { emitStatus, formatStatus } from "../src/status";

describe("status lines", () => {
  test("one JSON object per line with progress clamped", () => {
    expect(formatStatus({ state: "online", detail: "https://plane" })).toBe('{"state":"online","detail":"https://plane"}');
    expect(formatStatus({ state: "pulling", detail: "layer 3", progress: 1.4 })).toBe('{"state":"pulling","detail":"layer 3","progress":1}');
    expect(formatStatus({ state: "pulling", detail: "x", progress: -1 })).toContain('"progress":0');
  });

  test("writes to the given sink with a newline", () => {
    const lines: string[] = [];
    emitStatus({ state: "error", detail: "no backend" }, { write: (text) => lines.push(text) });
    expect(lines).toEqual(['{"state":"error","detail":"no backend"}\n']);
  });
});
