import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OriginLink } from "./origin-link";

const PINWHEEL = "M5.042 15.165";
const slack = (
  overrides: Partial<Parameters<typeof OriginLink>[0]["connector"] & object> = {},
): NonNullable<Parameters<typeof OriginLink>[0]["connector"]> => ({
  source: "slack",
  sender_name: "Sundar",
  sender_avatar_url: null,
  permalink: "https://example.slack.com/archives/C1/p1700000000000100",
  ...overrides,
});

test("a Slack-born thread carries the Slack mark that opens its permalink in a new tab", () => {
  const html = renderToStaticMarkup(<OriginLink connector={slack()} />);
  expect(html).toContain('href="https://example.slack.com/archives/C1/p1700000000000100"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noreferrer"');
  expect(html).toContain('aria-label="Open in Slack"');
  expect(html).toContain(PINWHEEL);
});

test("a channel thread names its channel, and says only that it is a channel until the name is known", () => {
  const named = renderToStaticMarkup(
    <OriginLink connector={slack({ channel_kind: "channel", channel_name: "deploys" })} />,
  );
  expect(named).toContain(">#deploys<");
  expect(named).toContain('aria-label="Open #deploys in Slack"');
  const unnamed = renderToStaticMarkup(<OriginLink connector={slack({ channel_kind: "channel", channel_name: null })} />);
  expect(unnamed).toContain(">Channel<");
  expect(unnamed).toContain('aria-label="Open in Slack"');
  const priv = renderToStaticMarkup(
    <OriginLink connector={slack({ channel_kind: "private_channel", channel_name: null })} />,
  );
  expect(priv).toContain(">Private channel<");
});

test("a DM says so and that its link opens only for the person in it", () => {
  const html = renderToStaticMarkup(
    <OriginLink
      connector={slack({
        channel_kind: "dm",
        channel_name: null,
        permalink: "https://example.slack.com/archives/D1/p1700000000000100",
      })}
    />,
  );
  expect(html).toContain(">DM<");
  expect(html).toContain('aria-label="Slack DM from Sundar. The link opens only for them"');
  expect(html).toContain('href="https://example.slack.com/archives/D1/p1700000000000100"');
  const unknownSender = renderToStaticMarkup(
    <OriginLink connector={slack({ channel_kind: "dm", channel_name: null, sender_name: null })} />,
  );
  expect(unknownSender).toContain('aria-label="Slack DM. The link opens only for its sender"');
  const group = renderToStaticMarkup(<OriginLink connector={slack({ channel_kind: "group_dm", channel_name: null })} />);
  expect(group).toContain(">Group DM<");
  expect(group).toContain('aria-label="Slack group DM. The link opens only for its members"');
});

test("a thread stamped before the kind existed reads it off the permalink's channel id", () => {
  const dm = renderToStaticMarkup(
    <OriginLink connector={slack({ permalink: "https://example.slack.com/archives/D0C117GTEUS/p1789363920493089" })} />,
  );
  expect(dm).toContain(">DM<");
  expect(dm).toContain('aria-label="Slack DM from Sundar. The link opens only for them"');
  const priv = renderToStaticMarkup(
    <OriginLink connector={slack({ permalink: "https://example.slack.com/archives/G0PRIV/p1789363920493089" })} />,
  );
  expect(priv).toContain(">Private channel<");
  expect(renderToStaticMarkup(<OriginLink connector={slack({ permalink: "https://example.slack.com/x/1" })} />)).not.toContain(
    "<span",
  );
});

test("the rail row keeps the mark alone but says the same thing on hover", () => {
  const html = renderToStaticMarkup(
    <OriginLink connector={slack({ channel_kind: "dm", channel_name: null })} compact />,
  );
  expect(html).not.toContain("<span");
  expect(html).toContain(PINWHEEL);
  expect(html).toContain('title="Slack DM from Sundar. The link opens only for them"');
});

test("no link is rendered without a permalink or for a thread typed in the product", () => {
  expect(renderToStaticMarkup(<OriginLink connector={slack({ permalink: null })} />)).toBe("");
  expect(renderToStaticMarkup(<OriginLink connector={null} />)).toBe("");
  expect(renderToStaticMarkup(<OriginLink />)).toBe("");
});

test("a source spelled like an inherited object property still falls back", () => {
  for (const source of ["constructor", "__proto__", "toString"]) {
    const html = renderToStaticMarkup(
      <OriginLink
        connector={{ source, sender_name: null, sender_avatar_url: null, permalink: "https://x.example/1" }}
      />,
    );
    expect(html).toContain(`aria-label="Open in ${source}"`);
    expect(html).not.toContain(PINWHEEL);
  }
});

test("an unknown connector still links, labelled by its id with a neutral mark and no kind", () => {
  const html = renderToStaticMarkup(
    <OriginLink
      connector={{ source: "teams", sender_name: null, sender_avatar_url: null, permalink: "https://teams.example/t/1" }}
    />,
  );
  expect(html).toContain('aria-label="Open in teams"');
  expect(html).toContain('href="https://teams.example/t/1"');
  expect(html).not.toContain("<span");
  expect(html).not.toContain(PINWHEEL);
});
