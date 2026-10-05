import { expect, test } from "bun:test";
import { verificationNotice } from "./verification-notice";

test("a confirmation landing is explained in plain words, problems before success", () => {
  expect(verificationNotice({})).toBeNull();
  expect(verificationNotice({ verified: "1" })).toEqual({
    tone: "ok",
    text: "Your email address is confirmed. Sign in to continue.",
  });
  expect(verificationNotice({ verified: "1", error: "link_expired" })?.text).toContain("has expired");
  expect(verificationNotice({ error: "link_invalid" })?.text).toContain("is not valid");
  expect(verificationNotice({ error: "signup_replaced" })?.text).toContain("a newer one replaced");
  expect(verificationNotice({ declined: "1" })?.text).toContain("was cancelled");
  expect(verificationNotice({ error: ["a", "b"] })).toBeNull();
});
