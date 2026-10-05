import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CheckYourEmail } from "./check-your-email";

test("the waiting card names the address and holds the resend until the cooldown has passed", () => {
  const html = renderToStaticMarkup(
    <CheckYourEmail email="dana@acme.com" onResend={async () => null} onBack={() => {}} />,
  );
  expect(html).toContain("Check your email");
  expect(html).toContain("dana@acme.com");
  expect(html).toContain("Resend in 60s");
  expect(html).toContain("disabled");
  expect(html).toContain("Back to sign in");
});
