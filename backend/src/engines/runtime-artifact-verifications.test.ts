import { expect, test } from "bun:test";
import "../../test/helpers";
import { recordRuntimeArtifactVerified, runtimeArtifactVerified } from "./runtime-artifact-verifications";

test("a sandbox's artifact verification persists per generation, and recording it twice is harmless", async () => {
  const sandboxId = `sandbox-${crypto.randomUUID()}`;
  expect(await runtimeArtifactVerified(sandboxId, "gen-a")).toBe(false);
  await recordRuntimeArtifactVerified(sandboxId, "gen-a");
  await recordRuntimeArtifactVerified(sandboxId, "gen-a");
  expect(await runtimeArtifactVerified(sandboxId, "gen-a")).toBe(true);
  expect(await runtimeArtifactVerified(sandboxId, "gen-b")).toBe(false);
  expect(await runtimeArtifactVerified(`other-${sandboxId}`, "gen-a")).toBe(false);
});
