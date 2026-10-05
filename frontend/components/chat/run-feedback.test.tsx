import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { feedbackFailureMessage, RunFeedbackForm } from "./run-feedback";

// The modal around the form mounts through the Radix portal (client-only), so
// static markup holds the form itself: the choice, the note, the send row.

const noop = () => {};
const render = (props: Partial<Parameters<typeof RunFeedbackForm>[0]> = {}) =>
  renderToStaticMarkup(
    <RunFeedbackForm
      verdict={null}
      text=""
      busy={false}
      error={null}
      sent={false}
      onVerdict={noop}
      onText={noop}
      onSubmit={noop}
      onClose={noop}
      {...props}
    />,
  );

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("RunFeedbackForm", () => {
  test("offers Good and Bad, a note, and holds Send until a verdict is picked", () => {
    const html = render();
    expect(html).toContain('aria-label="How did this run go?"');
    expect(count(html, 'aria-pressed="false"')).toBe(2);
    expect(html).toContain(">Good<");
    expect(html).toContain(">Bad<");
    expect(html).toContain('aria-label="Feedback note"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*><span[^>]*>Send<\/span>/);
  });

  test("marks the picked verdict and frees Send", () => {
    const html = render({ verdict: "bad", text: "The diff missed a file" });
    expect(count(html, 'aria-pressed="true"')).toBe(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*>[\s\S]*?Bad</);
    expect(html).toContain("The diff missed a file");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*><span[^>]*>Send<\/span>/);
  });

  test("shows the refusal and, while sending, holds Send", () => {
    expect(render({ verdict: "good", error: "This run is no longer available." })).toContain(
      '<p role="alert" class="text-paragraph-xs text-error-base">This run is no longer available.</p>',
    );
    expect(render({ verdict: "good", busy: true })).toMatch(/<button[^>]*disabled=""[^>]*><span[^>]*>Sending<\/span>/);
  });

  test("after sending, thanks the person instead of asking again", () => {
    const html = render({ verdict: "good", sent: true });
    expect(html).toContain("Thanks, your feedback was sent.");
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toContain(">Send<");
  });
});

describe("feedbackFailureMessage", () => {
  test("says what the backend refused in plain words", () => {
    expect(feedbackFailureMessage(429, { error: "rate_limited" })).toBe(
      "Too many messages in a short time. Try again in a few minutes.",
    );
    expect(feedbackFailureMessage(404, { error: "not_found" })).toBe("This run is no longer available.");
    expect(feedbackFailureMessage(400, { error: "verdict must be good or bad" })).toBe("verdict must be good or bad");
    expect(feedbackFailureMessage(500, {})).toBe("Could not send the feedback. Try again.");
  });
});
