import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A bot thread starts on its conversation: the runtime rail opens on demand, so the
// composer keeps the column at roster-plus-thread widths.
describe("bot thread rail", () => {
  const pane = readFileSync(join(import.meta.dir, "bot-thread-pane.tsx"), "utf8");
  const sessionView = readFileSync(join(import.meta.dir, "../chat/session-view.tsx"), "utf8");

  test("the bot pane mounts the session view with the rail closed by default", () => {
    expect(pane).toContain("railDefaultOpen={false}");
  });

  test("the session view keeps the rail open by default everywhere else", () => {
    expect(sessionView).toContain("railDefaultOpen = true");
    expect(sessionView).toContain("railOverride ?? (railDefaultOpen && hasRuntimeSurfaces)");
  });
});
