import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { GoogleSignInButton } from "./google-sign-in-button";

test("renders Google sign-in only when the backend advertises it", () => {
  expect(renderToStaticMarkup(<GoogleSignInButton enabled={false} />)).toBe("");
  expect(renderToStaticMarkup(<GoogleSignInButton enabled />)).toContain("Continue with Google");
});
