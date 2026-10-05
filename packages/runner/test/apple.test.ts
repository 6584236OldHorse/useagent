// Apple containers, by hand on a Mac: `bun test test/apple.test.ts`. Skipped
// anywhere the container tool is missing, which includes CI.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppleContainerBackend } from "../src/backends/apple";
import { DOCKERFILE, TEST_IMAGE, runBackendSuite } from "./backend-suite";

const backend = new AppleContainerBackend();
runBackendSuite("apple container backend", backend, async () => {
  const dir = await mkdtemp(join(tmpdir(), "useagent-runner-image-"));
  try {
    await writeFile(join(dir, "Dockerfile"), DOCKERFILE);
    const build = Bun.spawn(["container", "build", "-t", TEST_IMAGE, dir], { stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(build.stderr).text();
    if ((await build.exited) !== 0) throw new Error(`test image build failed: ${stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, process.env.USEAGENT_TEST_APPLE === "1" ? await backend.available() : "set USEAGENT_TEST_APPLE=1 to run against Apple containers");
