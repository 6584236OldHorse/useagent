import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { SandboxProviderKind } from "@useagent/sandbox-contract";
import type { SandboxHandle, SandboxProvider } from "../sandboxes/provider";
import { sandboxForBinding, type SandboxBinding, type SandboxCredentialSource } from "../sandboxes/binding";
import {
  forgetLiveSandbox,
  forgetLiveThreadSandbox,
  getLiveSandbox,
  getLiveThreadSandbox,
  rememberLiveThreadSandbox,
} from "./sandbox-runtime";

function sandbox(id: string, providerKind: SandboxProviderKind = "cube"): SandboxHandle {
  return { id, providerKind } as SandboxHandle;
}

describe("live thread sandbox registry", () => {
  const threadId = "thread-runtime-cache";

  afterEach(() => forgetLiveThreadSandbox(threadId));

  test("retains the live SDK object, not just its durable id", () => {
    const box = sandbox("sandbox-1");

    rememberLiveThreadSandbox(threadId, box);

    expect(getLiveThreadSandbox(threadId)).toBe(box);
  });

  test("a rotated sandbox replaces the prior process-local object", () => {
    const replacement = sandbox("sandbox-2");
    rememberLiveThreadSandbox(threadId, sandbox("sandbox-1"));

    rememberLiveThreadSandbox(threadId, replacement);

    expect(getLiveThreadSandbox(threadId)).toBe(replacement);
  });

  test("old cleanup cannot evict a newer sandbox for the same thread", () => {
    const replacement = sandbox("sandbox-2");
    rememberLiveThreadSandbox(threadId, replacement);

    forgetLiveThreadSandbox(threadId, "sandbox-1");

    expect(getLiveThreadSandbox(threadId)).toBe(replacement);
  });
});

describe("verified sandbox reuse", () => {
  const threadId = "thread-verified-reuse";
  const lookups: string[] = [];

  function binding(kind: SandboxProviderKind = "cube", credential: SandboxCredentialSource = "env"): SandboxBinding {
    const provider = {
      get: async (id: string) => {
        lookups.push(id);
        return sandbox(id, kind);
      },
    } as unknown as SandboxProvider;
    return { kind, provider, credential, snapshot: null, userId: null, logins: [] };
  }

  afterEach(() => {
    lookups.length = 0;
    setSystemTime();
    forgetLiveThreadSandbox(threadId);
    for (const id of ["sandbox-1", "sandbox-2"]) {
      const live = getLiveSandbox(id);
      if (live) forgetLiveSandbox(live);
    }
  });

  test("the thread's leased handle serves its own sandbox without a provider lookup", async () => {
    const leased = sandbox("sandbox-1");
    rememberLiveThreadSandbox(threadId, leased);

    expect(await sandboxForBinding(binding(), "sandbox-1")).toBe(leased);
    expect(lookups).toEqual([]);
  });

  test("a leased handle for another sandbox id falls back to the full lookup", async () => {
    rememberLiveThreadSandbox(threadId, sandbox("sandbox-1"));

    expect((await sandboxForBinding(binding(), "sandbox-2")).id).toBe("sandbox-2");
    expect(lookups).toEqual(["sandbox-2"]);
  });

  test("a personal credential or another provider always looks up again", async () => {
    rememberLiveThreadSandbox(threadId, sandbox("sandbox-1"));

    await sandboxForBinding(binding("cube", "user"), "sandbox-1");
    await sandboxForBinding(binding("daytona"), "sandbox-1");

    expect(lookups).toEqual(["sandbox-1", "sandbox-1"]);
  });

  test("a full lookup with no lease is reused for one minute", async () => {
    setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
    const first = await sandboxForBinding(binding(), "sandbox-2");
    expect(await sandboxForBinding(binding(), "sandbox-2")).toBe(first);
    expect(lookups).toEqual(["sandbox-2"]);

    setSystemTime(new Date("2026-10-02T00:01:00.000Z"));
    expect(await sandboxForBinding(binding(), "sandbox-2")).not.toBe(first);
    expect(lookups).toEqual(["sandbox-2", "sandbox-2"]);
  });

  test("a failed handle is dropped wherever it is held", async () => {
    const leased = sandbox("sandbox-1");
    rememberLiveThreadSandbox(threadId, leased);
    const verified = await sandboxForBinding(binding(), "sandbox-2");

    expect(forgetLiveSandbox(leased)).toBe(true);
    expect(forgetLiveSandbox(verified)).toBe(true);
    expect(forgetLiveSandbox(leased)).toBe(false);
    expect(getLiveThreadSandbox(threadId)).toBeNull();
    expect(getLiveSandbox("sandbox-1")).toBeNull();
    expect(getLiveSandbox("sandbox-2")).toBeNull();
  });

  test("pausing or releasing a sandbox drops its verified lookup", async () => {
    await sandboxForBinding(binding(), "sandbox-2");

    forgetLiveThreadSandbox("another-thread", "sandbox-2");

    expect(getLiveSandbox("sandbox-2")).toBeNull();
  });
});
