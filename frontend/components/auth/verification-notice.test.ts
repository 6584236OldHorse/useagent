import { expect, test } from "bun:test";
import { verificationNotice } from "./verification-notice";

test("a confirmation landing is explained in plain words, problems before success", () => {
  expect(verificationNotice({})).toBeNull();
  expect(verificationNotice({ verified: "1" })).toEqual({
    tone: "ok",
    text: "Your email address is confirmed. Sign in to continue.",
  });
  expect(verificationNotice({ verified: "1", error: "TOKEN_EXPIRED" })?.text).toContain("has expired");
  expect(verificationNotice({ error: "INVALID_TOKEN" })?.text).toContain("is not valid");
  expect(verificationNotice({ error: "signup_replaced" })?.text).toContain("a newer one replaced");
  expect(verificationNotice({ error: ["a", "b"] })).toBeNull();
});
