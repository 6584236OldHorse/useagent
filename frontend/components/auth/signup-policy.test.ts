import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";

import LoginPage from "@/app/login/[[...login]]/page";
import { AuthForm } from "@/app/login/auth-form";
import SignupPage from "@/app/signup/[[...signup]]/page";

describe("self-service signup UI policy", () => {
  test("redirects public signup to login", () => {
    expect(() => SignupPage()).toThrow("NEXT_REDIRECT");
  });

  test("keeps a safe desktop callback on native sign-in", async () => {
    const page = (await LoginPage({
      searchParams: Promise.resolve({ redirect_url: "/agent/new?desktop=1" }),
    })) as ReactElement<{ callbackURL: string }>;
    expect(page.type).toBe(AuthForm);
    expect(page.props.callbackURL).toBe("/agent/new?desktop=1");

    const external = (await LoginPage({
      searchParams: Promise.resolve({ redirect_url: "//attacker.example/path" }),
    })) as ReactElement<{ callbackURL: string }>;
    expect(external.props.callbackURL).toBe("/");
  });
});
