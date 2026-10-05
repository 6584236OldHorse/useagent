import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "../http";
import { isPublicApiPath, orgScope } from "./org";

describe("internal automation auth boundary", () => {
  test("bypasses session auth only for the exact self-authenticated bridge", () => {
    expect(isPublicApiPath("/api/internal/automation")).toBe(true);
    expect(isPublicApiPath("/api/internal/automation/anything")).toBe(false);
    expect(isPublicApiPath("/api/internal/automation-evil")).toBe(false);
    expect(isPublicApiPath("/api/internal/gateway-approval/consume")).toBe(true);
    expect(isPublicApiPath("/api/internal/gateway-approval/consume/extra")).toBe(false);
    expect(isPublicApiPath("/api/internal/github-operations")).toBe(true);
    expect(isPublicApiPath("/api/internal/github-operations/extra")).toBe(false);
    expect(isPublicApiPath("/api/internal/github-operations-evil")).toBe(false);
    expect(isPublicApiPath("/api/internal/codex-relay/one-use-capability")).toBe(true);
    expect(isPublicApiPath("/api/internal/codex-relay")).toBe(false);
    expect(isPublicApiPath("/api/internal/codex-relay-evil/token")).toBe(false);
    expect(isPublicApiPath("/api/internal/operator/pump-thread")).toBe(true);
    expect(isPublicApiPath("/api/internal/operator")).toBe(false);
    expect(isPublicApiPath("/api/internal/operator-evil/pump-thread")).toBe(false);
    expect(isPublicApiPath("/api/integrations/slack/callback")).toBe(true);
    expect(isPublicApiPath("/api/integrations/callback/slack")).toBe(true);
    expect(isPublicApiPath("/api/integrations/slack/callback/extra")).toBe(false);
    expect(isPublicApiPath("/api/integrations/callback/slack-evil")).toBe(false);
    expect(isPublicApiPath("/api/integrations/slack/connect")).toBe(false);
    expect(isPublicApiPath("/api/integrations/github/callback")).toBe(false);
  });
});

describe("sandbox preview auth boundary", () => {
  test("only a capability view skips the session", () => {
    expect(isPublicApiPath("/api/desktop-proxy/thread-1/view/v1.cap.sig/vnc.html")).toBe(true);
    expect(isPublicApiPath("/api/port-proxy/thread-1/view/v1.cap.sig")).toBe(true);
    expect(isPublicApiPath("/api/desktop-proxy/thread-1/vnc.html")).toBe(false);
    expect(isPublicApiPath("/api/desktop-proxy/thread-1/ready")).toBe(false);
    expect(isPublicApiPath("/api/port-proxy/thread-1/3000/view/x")).toBe(false);
    expect(isPublicApiPath("/api/desktop-proxy/thread-1/view")).toBe(false);
    expect(isPublicApiPath("/api/api-keys/view/v1.cap.sig")).toBe(false);
  });

  test("an opaque-origin page never rides the product session", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", orgScope);
    app.post("/api/api-keys", (c) => c.json({ minted: true }));
    const response = await app.request("/api/api-keys", {
      method: "POST",
      headers: { origin: "null", cookie: "better-auth.session_token=member" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden_origin" });
  });
});
