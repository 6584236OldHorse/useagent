import { describe, expect, test } from "bun:test";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";

import { config, proxy } from "./proxy";

describe("authentication proxy", () => {
  test("excludes only the exact public download page from authentication", () => {
    expect(
      unstable_doesMiddlewareMatch({
        config,
        url: "https://useagent.example.com/download",
      }),
    ).toBe(false);
    expect(
      unstable_doesMiddlewareMatch({
        config,
        url: "https://useagent.example.com/download-private",
      }),
    ).toBe(true);
  });

  test("opens only the development preview escape hatch", () => {
    const previousMode = process.env.NODE_ENV;
    const previousPreview = process.env.USEAGENT_PREVIEW_OPEN;
    process.env.USEAGENT_PREVIEW_OPEN = "1";
    try {
      process.env.NODE_ENV = "development";
      expect(
        proxy(new NextRequest("https://useagent.example.com/agent/new")).headers.get(
          "x-middleware-next",
        ),
      ).toBe("1");

      process.env.NODE_ENV = "production";
      expect(proxy(new NextRequest("https://useagent.example.com/agent/new")).status).toBe(307);
    } finally {
      if (previousMode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousMode;
      if (previousPreview === undefined) delete process.env.USEAGENT_PREVIEW_OPEN;
      else process.env.USEAGENT_PREVIEW_OPEN = previousPreview;
    }
  });

  test.each(["/login", "/signup"])("keeps %s public", (path) => {
    expect(
      proxy(new NextRequest(`https://useagent.example.com${path}`)).headers.get(
        "x-middleware-next",
      ),
    ).toBe("1");
  });

  test.each(["__Secure-better-auth.session_token", "better-auth.session_token"])(
    "accepts the Better Auth session cookie %s",
    (name) => {
      const request = new NextRequest("https://useagent.example.com/agent/new", {
        headers: { cookie: `${name}=opaque-session-token` },
      });
      expect(proxy(request).headers.get("x-middleware-next")).toBe("1");
    },
  );

  test("redirects anonymous navigation to login", () => {
    const response = proxy(new NextRequest("https://useagent.example.com/agent/new"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://useagent.example.com/login");
  });

  test("keeps pages on their canonical no-slash path", () => {
    const response = proxy(
      new NextRequest("https://useagent.example.com/agent/new/?skill=fix", {
        headers: { cookie: "better-auth.session_token=opaque" },
      }),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "https://useagent.example.com/agent/new?skill=fix",
    );
  });

  test("allows health and the exact icon but protects similarly named routes", () => {
    for (const path of ["/healthz", "/icon.svg?v=current"]) {
      expect(
        proxy(new NextRequest(`https://useagent.example.com${path}`)).headers.get(
          "x-middleware-next",
        ),
      ).toBe("1");
    }
    for (const path of ["/icon.svg-private", "/icon.svg/private"]) {
      expect(proxy(new NextRequest(`https://useagent.example.com${path}`)).status).toBe(307);
    }
  });
});
