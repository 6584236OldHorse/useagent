import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CheckYourEmail, mailText } from "./check-your-email";

const render = (mail: Parameters<typeof mailText>[1]) =>
  renderToStaticMarkup(
    <CheckYourEmail email="dana@acme.com" mail={mail} onResend={async () => ({ mail })} onBack={() => {}} />,
  );

test("the waiting card says what the server said about the mail, no more", () => {
  expect(mailText("dana@acme.com", { kind: "if_new" })).toContain("If dana@acme.com is new here");
  expect(mailText("dana@acme.com", { kind: "if_new" })).toContain("a link is not sent to an address that is already confirmed");
  expect(mailText("dana@acme.com", { kind: "sent" })).toContain("on its way to dana@acme.com");
  expect(mailText("dana@acme.com", { kind: "held", retryAfterSeconds: 1500 })).toContain("ask again in 25 minutes");
  expect(mailText("dana@acme.com", { kind: "closed" })).toContain("sign-up is closed on this server");

  const sent = render({ kind: "sent" });
  expect(sent).toContain("Check your email");
  expect(sent).toContain("Ask again in 60s");
  expect(sent).toContain("disabled");
  expect(sent).toContain("Back to sign in");

  const closed = render({ kind: "closed" });
  expect(closed).toContain("Sign-up is closed");
  expect(closed).not.toContain("Ask again");
});
