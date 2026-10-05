import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TurnSender } from "./turn-sender";

const PINWHEEL = "M5.042 15.165";

test("a Slack-born turn shows the sender's display name, avatar, and the Slack mark on the avatar", () => {
  const html = renderToStaticMarkup(
    <TurnSender
      connector={{
        source: "slack",
        sender_name: "Sundar",
        sender_avatar_url: "https://avatars.example/sundar-192.png",
        permalink: "https://example.slack.com/archives/C1/p1",
      }}
    />,
  );
  expect(html).toContain("Sundar");
  expect(html).toContain('src="https://avatars.example/sundar-192.png"');
  expect(html).toContain('aria-label="Sent from Slack"');
  expect(html).toContain(PINWHEEL);
});

test("a sender the channel could not describe still reads as a Slack member with an initial", () => {
  const html = renderToStaticMarkup(
    <TurnSender
      connector={{ source: "slack", sender_name: null, sender_avatar_url: null, permalink: null }}
    />,
  );
  expect(html).toContain("Slack member");
  expect(html).not.toContain("<img");
  expect(html).toContain(">S<");
  expect(html).toContain('aria-label="Sent from Slack"');
});

test("an unknown connector keeps its id as the label and a neutral mark", () => {
  const html = renderToStaticMarkup(
    <TurnSender
      connector={{ source: "teams", sender_name: "Priya", sender_avatar_url: null, permalink: null }}
    />,
  );
  expect(html).toContain("Priya");
  expect(html).toContain('aria-label="Sent from teams"');
  expect(html).not.toContain(PINWHEEL);
});

test("a turn typed in the product renders nothing", () => {
  expect(renderToStaticMarkup(<TurnSender connector={null} />)).toBe("");
  expect(renderToStaticMarkup(<TurnSender connector={undefined} />)).toBe("");
});
