import { describe, expect, test } from "bun:test";
import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { cloneElement, createElement, type ReactElement } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";

import LoginPage from "@/app/login/[[...login]]/page";
import { AuthForm } from "@/app/login/auth-form";
import SignupPage from "@/app/signup/[[...signup]]/page";

const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} } as unknown as AppRouterInstance;
const renderToStaticMarkup = (node: ReactElement) =>
  renderMarkup(createElement(AppRouterContext.Provider, { value: router }, node));

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

  test("the real login page swaps the browser form for the frozen desktop control", async () => {
    const page = (await LoginPage({ searchParams: Promise.resolve({}) })) as ReactElement<{
      initialDesktopBridge?: { platform: "darwin"; openExternal(url: string): void } | null;
    }>;
    const browser = renderToStaticMarkup(cloneElement(page, { initialDesktopBridge: null }));
    const desktop = renderToStaticMarkup(cloneElement(page, {
      initialDesktopBridge: { platform: "darwin", openExternal() {} },
    }));

    expect(browser).toContain("Welcome back");
    expect(browser).not.toContain("Continue in browser");
    expect(desktop).toContain("Continue in browser");
    expect(desktop).not.toContain("Welcome back");
  });
});
