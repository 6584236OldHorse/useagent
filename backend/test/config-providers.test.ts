import { afterEach, expect, test } from "bun:test";
import { deploymentProvidedProviders } from "../src/provider-gateway/provider";
import { json } from "./helpers";

const original = process.env.OPENAI_API_KEY;
afterEach(() => {
  if (original === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = original;
});

test("deploymentProvidedProviders names each provider the server keys serve, never a value", () => {
  expect(deploymentProvidedProviders({})).toEqual({
    anthropic: false,
    openai: false,
    openrouter: false,
    cerebras: false,
  });
  expect(
    deploymentProvidedProviders({ OPENAI_API_KEY: "sk-live", ANTHROPIC_API_KEY: "   " }),
  ).toEqual({ anthropic: false, openai: true, openrouter: false, cerebras: false });
});

test("GET /api/config reports the deployment-provided providers and follows the env", async () => {
  process.env.OPENAI_API_KEY = "sk-test-deployment";
  const served = await json<{ providers: Record<string, boolean>; runner: unknown; sandbox: unknown }>("/api/config");
  expect(served.status).toBe(200);
  expect(served.body.providers.openai).toBe(true);
  // What a runner must speak and boot; no image is configured in the test environment.
  expect(served.body.runner).toEqual({ enabled: true, minProtocol: 2, image: null });
  expect(JSON.stringify(served.body)).not.toContain("sk-test-deployment");
  // The sandbox block names the provider a person reads, following where the
  // deployment points: the test environment runs the default provider, and the
  // E2B-protocol plugin reads as E2B on e2b.app and Cube elsewhere.
  expect(served.body.sandbox).toMatchObject({ provider: "daytona", label: "Daytona" });
  const previous = { provider: process.env.SANDBOX_PROVIDER, url: process.env.CUBE_API_URL };
  try {
    process.env.SANDBOX_PROVIDER = "cube";
    process.env.CUBE_API_URL = "https://api.e2b.app";
    expect((await json<{ sandbox: unknown }>("/api/config")).body.sandbox).toMatchObject({ provider: "cube", label: "E2B" });
    process.env.CUBE_API_URL = "https://cube.internal.example";
    expect((await json<{ sandbox: unknown }>("/api/config")).body.sandbox).toMatchObject({ provider: "cube", label: "Cube" });
  } finally {
    if (previous.provider === undefined) delete process.env.SANDBOX_PROVIDER;
    else process.env.SANDBOX_PROVIDER = previous.provider;
    if (previous.url === undefined) delete process.env.CUBE_API_URL;
    else process.env.CUBE_API_URL = previous.url;
  }
  delete process.env.OPENAI_API_KEY;
  const unserved = await json<{ providers: Record<string, boolean> }>("/api/config");
  expect(unserved.body.providers.openai).toBe(false);
});
