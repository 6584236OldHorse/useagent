import { DockerBackend } from "../src/backends/docker";
import { DOCKERFILE, TEST_IMAGE, runBackendSuite } from "./backend-suite";

const backend = new DockerBackend();
runBackendSuite("docker backend", backend, async () => {
  const build = Bun.spawn(["docker", "build", "-q", "-t", TEST_IMAGE, "-"], { stdin: new Blob([DOCKERFILE]), stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(build.stderr).text();
  if ((await build.exited) !== 0) throw new Error(`test image build failed: ${stderr}`);
}, await backend.available());
