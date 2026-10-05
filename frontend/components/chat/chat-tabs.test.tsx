import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatTabStrip } from "./chat-tabs";

const TABS = [
  { id: "r1", title: "Fix the login bug", href: "/session/r1" },
  { id: "r2", title: "Deploy to staging", href: "/session/r2" },
];

describe("ChatTabStrip", () => {
  test("nothing renders until a chat is open", () => {
    expect(renderToStaticMarkup(<ChatTabStrip tabs={[]} activeId={null} onClose={() => {}} />)).toBe("");
  });

  test("one tab per open chat, the current one selected, each closable", () => {
    const html = renderToStaticMarkup(<ChatTabStrip tabs={TABS} activeId="r2" onClose={() => {}} />);
    expect(html).toContain('data-testid="chat-tabs"');
    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html).toContain('href="/session/r1"');
    expect(html).toContain(">Deploy to staging<");
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-label="Close Fix the login bug"');
    const selected = html.match(/<a[^>]*aria-selected="true"[^>]*>/g) ?? [];
    expect(selected).toHaveLength(1);
    expect(selected[0]).toContain('href="/session/r2"');
  });
});
