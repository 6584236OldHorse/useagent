import { expect, test } from "bun:test";
import { loadIdentityMethods, parseIdentityMethods } from "./identity-methods-config";

test("keeps email-code login when public email signup is disabled", () => {
  expect(
    parseIdentityMethods({
      user_settings: {
        attributes: {
          email_address: {
            enabled: false,
            used_for_first_factor: true,
            first_factors: ["email_code"],
          },
          password: { enabled: true },
        },
        social: {},
        sign_up: { mode: "public" },
      },
    }),
  ).toEqual({
    google: false,
    github: false,
    emailPassword: true,
    emailCode: true,
    emailSignup: false,
    passwordSignup: false,
    signupAllowed: true,
  });
});

test("projects configured methods without forwarding browser credentials or accepting an upstream override", async () => {
  const settings = {
    attributes: {
      email_address: {
        enabled: false,
        used_for_first_factor: true,
        first_factors: ["email_code"],
      },
      password: { enabled: true },
    },
    social: {
      oauth_google: { enabled: true, authenticatable: true, not_selectable: true },
      oauth_github: { enabled: true, authenticatable: false },
    },
    sign_up: { mode: "restricted" },
  };
  const key = `pk_test_${btoa("identity.example.com$")}`;
  expect(
    await loadIdentityMethods(key, async (url, init) => {
      expect(url.href).toBe("https://identity.example.com/v1/environment");
      expect(init.credentials).toBe("omit");
      expect(init.headers).toBeUndefined();
      expect(init.redirect).toBe("error");
      return Response.json({ user_settings: settings, unrelated: "not returned" });
    }),
  ).toEqual({
    google: true,
    github: false,
    emailPassword: true,
    emailCode: true,
    emailSignup: false,
    passwordSignup: false,
    signupAllowed: false,
  });
  settings.attributes.email_address.enabled = true;
  settings.attributes.email_address.used_for_first_factor = true;
  settings.sign_up.mode = "public";
  expect(parseIdentityMethods({ user_settings: settings })).toEqual({
    google: true,
    github: false,
    emailPassword: true,
    emailCode: true,
    emailSignup: true,
    passwordSignup: true,
    signupAllowed: true,
  });
  expect(() => parseIdentityMethods(null)).toThrow("Sign-in methods are unavailable");
  expect(loadIdentityMethods(undefined)).rejects.toThrow();
});
