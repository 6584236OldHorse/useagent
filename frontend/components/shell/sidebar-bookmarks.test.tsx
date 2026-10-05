import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BookmarksSection } from "./sidebar-bookmarks";

describe("BookmarksSection", () => {
  test("empty, it says where the pins come from", () => {
    const html = renderToStaticMarkup(
      <BookmarksSection rows={[]} activeHref={null} onPin={() => {}} onUnpin={() => {}} />,
    );
    expect(html).toContain('data-testid="sidebar-bookmarks"');
    expect(html).toContain(">Bookmarks<");
    expect(html).toContain("Drag chats here to pin them");
    expect(html).not.toContain('data-session-ui="bookmark-row"');
  });

  test("a pinned chat is a row linking to its session, with an unpin control, the open one marked", () => {
    const html = renderToStaticMarkup(
      <BookmarksSection
        rows={[
          { id: "r1", title: "Fix the login bug", href: "/session/r1" },
          { id: "r2", title: "Deploy to staging", href: "/session/r2" },
        ]}
        activeHref="/session/r2"
        onPin={() => {}}
        onUnpin={() => {}}
      />,
    );
    expect(html.match(/data-session-ui="bookmark-row"/g)).toHaveLength(2);
    expect(html).toContain('href="/session/r1"');
    expect(html).toContain(">Fix the login bug<");
    expect(html).toContain('aria-label="Unpin Fix the login bug"');
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain("Drag chats here to pin them");
  });
});

test("a long list of pins folds behind Show N more", () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    id: `r${index}`,
    title: `Chat ${index}`,
    href: `/session/r${index}`,
  }));
  const html = renderToStaticMarkup(
    <BookmarksSection rows={rows} activeHref={null} onPin={() => {}} onUnpin={() => {}} />,
  );
  expect(html.match(/data-session-ui="bookmark-row"/g)).toHaveLength(24);
  expect(html).toContain(">Show 6 more<");
});
