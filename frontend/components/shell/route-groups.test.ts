import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { librarySidebarActiveFor } from "./library-sidebar";
import { APP_ROUTES } from "./route-prefetch";
import { threadSidebarActiveFor } from "./thread-sidebar";

const APP_DIR = join(import.meta.dir, "..", "..", "app");
const GROUPS = ["", "(workspace)", "(library)"];

describe("persistent shell route groups", () => {
  test("every prefetched route still resolves to a page", () => {
    for (const href of APP_ROUTES) {
      const found = GROUPS.some((group) => existsSync(join(APP_DIR, group, href, "page.tsx")));
      expect(found, `${href} has no page.tsx`).toBe(true);
    }
  });

  test("no page is reachable through two groups", () => {
    for (const href of APP_ROUTES) {
      const hits = GROUPS.filter((group) => existsSync(join(APP_DIR, group, href, "page.tsx")));
      expect(hits, `${href} resolves in ${hits.join(", ")}`).toHaveLength(1);
    }
  });

  test("the thread rail derives its active item from the pathname", () => {
    expect(threadSidebarActiveFor("/agent/new")).toBe("new");
    expect(threadSidebarActiveFor("/dashboard")).toBe("dashboard");
    expect(threadSidebarActiveFor("/bots")).toBe("bots");
    expect(threadSidebarActiveFor("/bots/abc")).toBe("bots");
    expect(threadSidebarActiveFor("/settings")).toBe("settings");
    expect(threadSidebarActiveFor("/session/abc")).toBeUndefined();
    expect(threadSidebarActiveFor("/agent/runs")).toBeUndefined();
    expect(threadSidebarActiveFor(null)).toBeUndefined();
  });

  test("the customize rail derives its active item from the pathname", () => {
    expect(librarySidebarActiveFor("/skills")).toBe("skills");
    expect(librarySidebarActiveFor("/wiki/some-doc")).toBe("wiki");
    expect(librarySidebarActiveFor("/agent/artifacts")).toBe("artifacts");
    expect(librarySidebarActiveFor("/agent/artifacts/abc")).toBe("artifacts");
    expect(librarySidebarActiveFor("/artifacts")).toBe("artifacts");
    expect(librarySidebarActiveFor("/review")).toBe("reviews");
    expect(librarySidebarActiveFor("/agent/automations")).toBe("automations");
    expect(librarySidebarActiveFor("/dashboard")).toBeUndefined();
    expect(librarySidebarActiveFor(null)).toBeUndefined();
  });
});
