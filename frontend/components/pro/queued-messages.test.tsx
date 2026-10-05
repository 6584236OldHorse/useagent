import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueuedMessages } from "./queued-messages";

const messages = [
  { id: "q1", position: 1, text: "okay keep working" },
  { id: "q2", position: 2, text: "then run the tests" },
];

test("numbered rows above the composer: Send now on the head only, Remove on every accepted row", () => {
  const html = renderToStaticMarkup(
    <QueuedMessages messages={messages} sendNowFor="q1" onSendNow={() => {}} onRemove={async () => {}} />,
  );
  expect(html).toContain('data-session-ui="queued-messages"');
  expect(html).toContain('aria-label="Queued messages"');
  expect(html.match(/data-session-ui="queued-message"/g)).toHaveLength(2);
  expect(html).toContain(">1<");
  expect(html).toContain(">2<");
  expect(html).toContain("okay keep working");
  expect(html).toContain("then run the tests");
  expect(html.split(">Send now<").length - 1).toBe(1);
  expect(html).toContain('aria-label="Remove queued message 1"');
  expect(html).toContain('aria-label="Remove queued message 2"');
});

test("a pending (still being accepted) row carries no actions; nothing renders for an empty queue", () => {
  const html = renderToStaticMarkup(
    <QueuedMessages
      messages={[...messages, { id: "pending", position: 3, text: "one more", pending: true }]}
      sendNowFor="pending"
      onSendNow={() => {}}
      onRemove={async () => {}}
    />,
  );
  expect(html).toContain("one more");
  expect(html).toContain(">3<");
  expect(html).not.toContain("Remove queued message 3");
  expect(html).not.toContain("Send now");
  expect(renderToStaticMarkup(<QueuedMessages messages={[]} />)).toBe("");
});

test("without handlers the rows are read-only; the list scrolls inside a bounded box", () => {
  const html = renderToStaticMarkup(<QueuedMessages messages={messages} />);
  expect(html).not.toContain("Send now");
  expect(html).not.toContain("Remove queued message");
  expect(html).toContain("max-h-40");
  expect(html).toContain("overflow-y-auto");
});

test("a row keeps its place in the whole queue even when an earlier slot is not shown", () => {
  const html = renderToStaticMarkup(
    <QueuedMessages messages={[{ id: "q2", position: 2, text: "behind a spawned session" }]} sendNowFor="child" onSendNow={() => {}} />,
  );
  expect(html).toContain(">2<");
  expect(html).not.toContain(">1<");
  expect(html).not.toContain("Send now");
});
