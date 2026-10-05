import { describe, expect, test } from "bun:test";
import { safeAuthRedirect } from "./safe-redirect";

describe("safeAuthRedirect", () => {
  test("keeps a plain path with its query and hash", () => {
    expect(safeAuthRedirect("/agent/new?x=1#top")).toBe("/agent/new?x=1#top");
  });

  test("falls back to the root for anything that is not a path on this site", () => {
    for (const value of [null, undefined, "", "https://attacker.example", "//attacker.example", "agent"]) {
      expect(safeAuthRedirect(value)).toBe("/");
    }
  });

  test("rejects a backslash that would normalize to another host", () => {
    expect(safeAuthRedirect("/\\x//attacker.example")).toBe("/");
    expect(safeAuthRedirect("/\\attacker.example")).toBe("/");
  });

  test("survives input the URL parser rejects and keeps a plain path the parser accepts", () => {
    expect(safeAuthRedirect("/\\[")).toBe("/");
    expect(safeAuthRedirect("/[")).toBe("/[");
  });
});
