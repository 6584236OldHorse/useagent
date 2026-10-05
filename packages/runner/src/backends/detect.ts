import type { RunnerBackendKind } from "@useagent/runner-protocol";
import { AppleContainerBackend } from "./apple";
import { DockerBackend } from "./docker";
import type { LocalBackend } from "./types";

export type BackendChoice = RunnerBackendKind | "auto";

/** Apple containers when the machine can run them, else Docker; a named choice is honoured or refused. */
export async function selectBackend(choice: BackendChoice): Promise<{ backend: LocalBackend } | { problem: string }> {
  const candidates: LocalBackend[] =
    choice === "auto" ? [new AppleContainerBackend(), new DockerBackend()]
    : choice === "apple" ? [new AppleContainerBackend()]
    : [new DockerBackend()];
  const problems: string[] = [];
  for (const backend of candidates) {
    const problem = await backend.available();
    if (problem === null) return { backend };
    problems.push(`${backend.kind}: ${problem}`);
  }
  return { problem: problems.join("; ") };
}
