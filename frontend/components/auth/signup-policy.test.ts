import { describe, expect, test } from "bun:test";
import type { ReactElement } from "react";

import SignupPage from "@/app/signup/[[...signup]]/page";
import { legacyAuthEnabled } from "@/lib/auth-mode";
import { AuthScreen } from "./auth-screen";
import { IdentityForm } from "./identity-form";

describe("self-service signup UI policy", () => {
  test("keeps signup on the identity provider and redirects the legacy route", async () => {
    if (legacyAuthEnabled) {
      await expect(SignupPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
        "NEXT_REDIRECT",
      );
      return;
    }

    const screen = (await SignupPage({
      searchParams: Promise.resolve({ redirect_url: "/agent/new?desktop=1" }),
    })) as ReactElement<{ children: ReactElement<{ mode: string; redirectTo: string }> }>;
    expect(screen.type).toBe(AuthScreen);
    expect(screen.props.children.type).toBe(IdentityForm);
    expect(screen.props.children.props.mode).toBe("sign-up");
    expect(screen.props.children.props.redirectTo).toBe("/agent/new?desktop=1");
  });
});
