import { describe, expect, test } from "bun:test";
import type { ClerkMiddlewareAuth } from "@clerk/nextjs/server";
import { type NextFetchEvent, type NextMiddleware, NextRequest, NextResponse } from "next/server";

import { config, identityMiddlewareProxy, identityProxy, legacyProxy, proxy } from "./proxy";

const event = {
  passThroughOnException() {},
  waitUntil() {},
} as unknown as NextFetchEvent;

function authFor(request: NextRequest): ClerkMiddlewareAuth {
  return (async () => ({
    userId: request.cookies.has("__session") ? "provider-user" : null,
  })) as ClerkMiddlewareAuth;
}

describe("authentication proxy", () => {
  test("selects legacy middleware only for the explicit frontend kill switch", () => {
    expect(proxy === legacyProxy).toBe(process.env.NEXT_PUBLIC_AUTH === "better-auth");
  });

  test("development preview bypasses the actual exported proxy before provider setup", async () => {
    const previousMode = process.env.NODE_ENV;
    const previousPreview = process.env.USEAGENT_PREVIEW_OPEN;
    process.env.NODE_ENV = "development";
    process.env.USEAGENT_PREVIEW_OPEN = "1";
    try {
      const response = await proxy(
        new NextRequest("https://useagent.example.com/agent/new"),
        event,
      );
      expect(response?.headers.get("x-middleware-next")).toBe("1");
    } finally {
      if (previousMode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousMode;
      if (previousPreview === undefined) delete process.env.USEAGENT_PREVIEW_OPEN;
      else process.env.USEAGENT_PREVIEW_OPEN = previousPreview;
    }
  });

  test("production never applies the development preview bypass", async () => {
    const previousMode = process.env.NODE_ENV;
    const previousPreview = process.env.USEAGENT_PREVIEW_OPEN;
    process.env.NODE_ENV = "production";
    process.env.USEAGENT_PREVIEW_OPEN = "1";
    let calls = 0;
    const next = (() => {
      calls += 1;
      return NextResponse.next();
    }) as NextMiddleware;
    try {
      await identityMiddlewareProxy(
        new NextRequest("https://useagent.example.com/agent/new"),
        event,
        next,
      );
      expect(calls).toBe(1);
    } finally {
      if (previousMode === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousMode;
      if (previousPreview === undefined) delete process.env.USEAGENT_PREVIEW_OPEN;
      else process.env.USEAGENT_PREVIEW_OPEN = previousPreview;
    }
  });

  test.each(["/login", "/signup"])(
    "normal auth route %s still passes through provider middleware",
    async (path) => {
      let calls = 0;
      const next = (() => {
        calls += 1;
        return NextResponse.next();
      }) as NextMiddleware;
      await identityMiddlewareProxy(
        new NextRequest(`https://useagent.example.com${path}`),
        event,
        next,
      );
      expect(calls).toBe(1);
    },
  );

  test("redirects anonymous navigation to login and accepts the Clerk session cookie", async () => {
    const anonymous = new NextRequest("https://useagent.example.com/agent/new");
    const signedIn = new NextRequest("https://useagent.example.com/agent/new", {
      headers: { cookie: "__session=opaque-session-token" },
    });

    const redirect = await identityProxy(authFor(anonymous), anonymous);
    const allowed = await identityProxy(authFor(signedIn), signedIn);

    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("https://useagent.example.com/login");
    expect(allowed.headers.get("x-middleware-next")).toBe("1");
  });

  test.each(["/login", "/login/factor-one", "/signup", "/signup/verify-email"])(
    "keeps the public auth route %s inside middleware context",
    async (path) => {
      const request = new NextRequest(`https://useagent.example.com${path}`);
      const response = await identityProxy(
        (async () => {
          throw new Error("public route asked for auth");
        }) as ClerkMiddlewareAuth,
        request,
      );

      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(config.matcher[0]).not.toContain("login|signup");
    },
  );

  test.each(["__Secure-better-auth.session_token", "better-auth.session_token"])(
    "keeps legacy navigation carrying %s behind the kill switch",
    (name) => {
      const request = new NextRequest("https://useagent.example.com/agent/new", {
        headers: { cookie: `${name}=opaque-session-token` },
      });
      expect(legacyProxy(request).headers.get("x-middleware-next")).toBe("1");
    },
  );

  test("keeps pages on their canonical no-slash path", async () => {
    const request = new NextRequest("https://useagent.example.com/agent/new/?skill=fix");
    const response = await identityProxy(authFor(request), request);

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "https://useagent.example.com/agent/new?skill=fix",
    );
  });

  test("allows the release health endpoint without a browser session", () => {
    const response = legacyProxy(new NextRequest("https://useagent.example.com/healthz"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  test("serves the exact favicon before authentication but protects similarly named routes", async () => {
    const icon = new NextRequest("https://useagent.example.com/icon.svg?v=current");
    let calls = 0;
    const next = (() => {
      calls += 1;
      return NextResponse.next();
    }) as NextMiddleware;
    expect(legacyProxy(icon).headers.get("x-middleware-next")).toBe("1");
    expect(
      (await identityMiddlewareProxy(icon, event, next))?.headers.get("x-middleware-next"),
    ).toBe("1");
    expect(calls).toBe(0);
    for (const path of ["/icon.svg-private", "/icon.svg/private"]) {
      const request = new NextRequest(`https://useagent.example.com${path}`);
      expect(legacyProxy(request).status).toBe(307);
      expect((await identityProxy(authFor(request), request)).status).toBe(307);
    }
  });
});
