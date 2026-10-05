// The plane's side of a machine that cannot boot the deployment's sandbox
// image: the runner's refusal reaches the run as the action the person should
// take, not as the raw digest text, through the provisioning every engine uses.

import { describe, expect, test } from "bun:test";
import { RpcError } from "@useagent/runner-protocol";
import { LocalProvider, SandboxImageUnavailableError, fakeLink, fakeLinkDirectory, localProviderConfig } from "@useagent/sandbox-local";
import { provisionSandbox } from "./sandbox-provision";
import { classifyTurnFailure } from "./turn-failure-classification";
import type { EngineRunContext } from "./types";

const IMAGE = { ref: "ghcr.io/useagenthq/sandbox:test", digest: "sha256:" + "a".repeat(64) };

function ctx(): EngineRunContext {
  return {
    runId: "run-a",
    prompt: "x",
    bootstrapContext: "",
    turnContext: "",
    workdir: "/work",
    threadId: "thread-a",
    orgId: "org-a",
    signal: new AbortController().signal,
    emit: async () => undefined,
    setSummary: () => {},
  };
}

/** A machine whose runner answers every create with one refusal, as the link would deliver it. */
function machineRefusing(code: string, message: string): LocalProvider {
  const link = fakeLink({
    id: "rn1",
    onCall: async (method) => {
      if (method === "sandbox.create") throw new RpcError(code, message);
      return null;
    },
  });
  return new LocalProvider(
    localProviderConfig({ SANDBOX_IMAGE_REF: IMAGE.ref, SANDBOX_IMAGE_DIGEST: IMAGE.digest }, { runnerId: "rn1" }),
    { links: fakeLinkDirectory([link]) },
  );
}

function provisionOn(provider: LocalProvider): Promise<unknown> {
  return provisionSandbox({
    ctx: ctx(),
    binding: { kind: "local", provider },
    snapshot: "",
    chip: "codex",
    create: {},
    resourceTarget: { cpu: 2, memory: 8 },
    noteLostWorkspace: async () => false,
  }).then(() => null, (error: unknown) => error);
}

describe("a local sandbox whose image is not on the machine", () => {
  test("a digest still missing after the machine's own pull fails the run with the update action, not the raw refusal", async () => {
    const error = await provisionOn(machineRefusing("image_missing", "the sandbox image is still downloading on this machine (42%) after 5 min"));
    expect(error).toBeInstanceOf(SandboxImageUnavailableError);
    const failure = classifyTurnFailure(error);
    expect(failure.summary).toBe(
      "error: Update the desktop app to get the new sandbox image: the sandbox image is still downloading on this machine (42%) after 5 min",
    );
    expect(failure.summary).not.toContain("—");
    expect(failure.summary).not.toMatch(/is not at digest/);
  });

  test("a pull that never started is reported as the machine waiting, with the runner's hint", async () => {
    const error = await provisionOn(
      machineRefusing("image_pull_stalled", "the sandbox image pull made no progress in 5 min; on a Mac this is usually the one-time keychain prompt waiting for an answer"),
    );
    expect((error as SandboxImageUnavailableError).code).toBe("image_pull_stalled");
    expect(classifyTurnFailure(error).summary).toBe(
      "error: Check the desktop app on the machine: the sandbox image pull made no progress in 5 min; on a Mac this is usually the one-time keychain prompt waiting for an answer",
    );
  });

  test("the machine's other refusals keep their own words", async () => {
    const error = await provisionOn(machineRefusing("refused", "this machine is at its limit of 2 running sandboxes"));
    expect(error).not.toBeInstanceOf(SandboxImageUnavailableError);
    expect(classifyTurnFailure(error).summary).toBe("error: this machine is at its limit of 2 running sandboxes");
  });
});
