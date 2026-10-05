import { expect, test } from "bun:test";
import { RiCloudLine, RiComputerLine } from "@remixicon/react";
import { type LocatedRun, runLocationPresentation } from "./run-location";
import type { Runner } from "./runner-data";
import type { SandboxProviderName } from "./runner-api";

const runner: Runner = {
  id: "rn_a",
  name: "Cloud",
  platform: "darwin-arm64",
  backend: "apple",
  version: "0.0.5",
  status: "online",
  lastSeenAt: null,
  logins: ["codex"],
  imageDigest: null,
  ownerUserId: "user_a",
};

function view(run: LocatedRun, runners: readonly Runner[] = [], deployment: SandboxProviderName | null = null) {
  const { icon, ...words } = runLocationPresentation(run, runners, deployment);
  return { ...words, glyph: icon === RiComputerLine ? "machine" : icon === RiCloudLine ? "cloud" : "other" };
}

// The glyph and the title follow the place, never the words: a machine may be
// enrolled under any name, and a recorded hosted provider outranks a Local ask.
test("presents a run by where it executes, not by what the words say", () => {
  expect(view({ sandbox_id: "local:rn_a:container_1" }, [runner])).toEqual({
    label: "Cloud",
    title: "Runs on Cloud",
    glyph: "machine",
  });
  expect(view({ sandbox_id: "sbx_1", sandbox_provider: "cube" }, [], { provider: "cube", label: "E2B" })).toEqual({
    label: "Cloud",
    title: "Runs on E2B",
    glyph: "cloud",
  });
  // A member is never told the vendor: without the operator's answer a hosted
  // run reads "Cloud", whatever provider it recorded.
  expect(view({ sandbox_id: null, sandbox_provider: "daytona", run_location: "local" })).toEqual({
    label: "Cloud",
    title: "Runs in the cloud",
    glyph: "cloud",
  });
  expect(view({ sandbox_id: "sbx_1", sandbox_provider: "cube" })).toEqual({
    label: "Cloud",
    title: "Runs in the cloud",
    glyph: "cloud",
  });
  // The operator sees it, also for a provider other than the deployment's own.
  expect(
    view({ sandbox_id: null, sandbox_provider: "daytona", run_location: "local" }, [], { provider: "cube", label: "E2B" }),
  ).toEqual({ label: "Cloud", title: "Runs on Daytona", glyph: "cloud" });
  expect(view({ sandbox_id: null, sandbox_provider: "local" })).toEqual({
    label: "This Mac",
    title: "Runs on This Mac",
    glyph: "machine",
  });
  expect(view({ sandbox_id: null, run_location: "cloud" })).toEqual({
    label: "Cloud",
    title: "Runs in the cloud",
    glyph: "cloud",
  });
});
