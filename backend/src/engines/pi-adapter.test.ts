import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makePiAdapter } from "./pi-adapter";

const priorGatewayUrl = process.env.PROVIDER_GATEWAY_PUBLIC_URL;
const priorGatewaySecret = process.env.PROVIDER_GATEWAY_SECRET;

beforeAll(() => {
  process.env.PROVIDER_GATEWAY_PUBLIC_URL = "https://gateway.example.test";
  process.env.PROVIDER_GATEWAY_SECRET = "provider-test-0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  if (priorGatewayUrl === undefined) delete process.env.PROVIDER_GATEWAY_PUBLIC_URL;
  else process.env.PROVIDER_GATEWAY_PUBLIC_URL = priorGatewayUrl;
  if (priorGatewaySecret === undefined) delete process.env.PROVIDER_GATEWAY_SECRET;
  else process.env.PROVIDER_GATEWAY_SECRET = priorGatewaySecret;
});

describe("Pi adapter", () => {
  test("wires bridge cleanup into the pre-resource sandbox fence", async () => {
    const calls: string[] = [];
    const expectedSandbox = {
      version: 1 as const,
      sandboxId: "retained",
      provider: "box" as const,
      credential: "env" as const,
      ownerOrgId: "org-1",
      ownerUserId: null,
      credentialGeneration: "a".repeat(64),
    };
    const adapter = makePiAdapter({
      bridges: {
        prepare: async (sandbox, expected) => {
          expect(expected).toEqual(expectedSandbox);
          calls.push(`fence:${sandbox.id}`);
        },
        ensure: async () => { throw new Error("not reached"); },
        get: () => undefined,
        awaitTeardown: async () => {},
        remove: async () => {},
      },
      prepareTurn: (async (_ctx: unknown, options: {
        prepareSandbox?: (sandbox: { id: string }) => Promise<void>;
      }) => {
        calls.push("prepare:start");
        await options.prepareSandbox?.({ id: "retained" });
        calls.push("resources:would-start");
        throw new Error("stop after fence");
      }) as never,
    });

    await expect(adapter.run({
      emit: async () => undefined,
      expectedSandbox,
      signal: new AbortController().signal,
    } as never)).rejects.toThrow("stop after fence");
    expect(calls).toEqual(["prepare:start", "fence:retained", "resources:would-start"]);
  });

  test("does not touch pending native teardown before sandbox preparation", async () => {
    const calls: string[] = [];
    const adapter = makePiAdapter({
      bridges: {
        ensure: async () => { throw new Error("not reached"); },
        get: () => undefined,
        awaitTeardown: async () => { calls.push("teardown"); },
        remove: async () => {},
      },
      prepareTurn: (async () => {
        calls.push("prepare");
        throw new Error("stop at sandbox fence");
      }) as never,
    });

    await expect(adapter.run({
      emit: async () => undefined,
      providerSession: {
        provider: "pi",
        nativeSessionId: "/sessions/pi.jsonl",
      },
      signal: new AbortController().signal,
    } as never)).rejects.toThrow("stop at sandbox fence");
    expect(calls).toEqual(["prepare"]);
  });
});
