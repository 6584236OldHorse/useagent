import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OriginLink } from "./origin-link";

const PINWHEEL = "M5.042 15.165";

test("a Slack-born thread carries the Slack mark that opens its permalink in a new tab", () => {
  const html = renderToStaticMarkup(
    <OriginLink
      connector={{
        source: "slack",
        sender_name: "Sundar",
        sender_avatar_url: null,
        permalink: "https://example.slack.com/archives/C1/p1700000000000100",
      }}
    />,
  );
  expect(html).toContain('href="https://example.slack.com/archives/C1/p1700000000000100"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noreferrer"');
  expect(html).toContain('aria-label="Open in Slack"');
  expect(html).toContain(PINWHEEL);
});

test("no link is rendered without a permalink or for a thread typed in the product", () => {
  expect(
    renderToStaticMarkup(
      <OriginLink
        connector={{ source: "slack", sender_name: "Sundar", sender_avatar_url: null, permalink: null }}
      />,
    ),
  ).toBe("");
  expect(renderToStaticMarkup(<OriginLink connector={null} />)).toBe("");
  expect(renderToStaticMarkup(<OriginLink />)).toBe("");
});

test("an unknown connector still links, labelled by its id with a neutral mark", () => {
  const html = renderToStaticMarkup(
    <OriginLink
      connector={{ source: "teams", sender_name: null, sender_avatar_url: null, permalink: "https://teams.example/t/1" }}
    />,
  );
  expect(html).toContain('aria-label="Open in teams"');
  expect(html).toContain('href="https://teams.example/t/1"');
  expect(html).not.toContain(PINWHEEL);
});
