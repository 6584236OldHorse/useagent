import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// The panes a session opens on demand: each is split behind next/dynamic in the loader
// and never imported by the session view from its own module, so its code leaves the
// route bundle and loads on the first open of its tab. Files is deliberately absent:
// it is the tab a thread with files opens on.
const ON_DEMAND_PANES = ["desktop-pane", "diff-pane", "editor-pane", "session-details-rail", "terminal-pane", "workspace-pane"];

describe("rail panes load on first open", () => {
  test("the session view takes the on-demand panes from the loader, never from their modules", () => {
    const view = read("./session-view.tsx");
    for (const pane of ON_DEMAND_PANES) {
      // Neither the aliased nor the relative spelling of the pane's own module.
      expect(view).not.toMatch(new RegExp(`import \\{[^}]*\\} from "(@/components/chat/|\\./)${pane}"`));
    }
    expect(view).toContain('from "@/components/chat/workspace-pane-loader"');
  });

  test("the loader splits each on-demand pane behind next/dynamic without server rendering", () => {
    const loader = read("./workspace-pane-loader.tsx");
    for (const pane of ON_DEMAND_PANES) {
      expect(loader).toContain(`import("@/components/chat/${pane}")`);
    }
    expect(loader.match(/ssr: false/g)?.length).toBe(ON_DEMAND_PANES.length);
  });
});
