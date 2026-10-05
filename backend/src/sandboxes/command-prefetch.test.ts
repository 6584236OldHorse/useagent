import { expect, test } from "bun:test";
import {
  dropPrefetchedSandboxResults,
  executeSandboxCommandOnce,
  prefetchSandboxCommand,
  takePrefetchedSandboxResult,
} from "./command-prefetch";

function sandbox(fail = false) {
  const commands: string[] = [];
  return {
    commands,
    process: {
      async executeCommand(command: string) {
        commands.push(command);
        if (fail) throw new Error("sandbox unreachable");
        return { exitCode: 0, result: `ran ${commands.length}` };
      },
    },
  };
}

test("a prefetched command is taken once, by its exact text, and anything else runs now", async () => {
  const box = sandbox();
  prefetchSandboxCommand(box, "probe", 10);
  prefetchSandboxCommand(box, "probe", 10);
  expect(box.commands).toEqual(["probe"]);
  expect(await executeSandboxCommandOnce(box, "probe", 10)).toEqual({ exitCode: 0, result: "ran 1" });
  expect(await executeSandboxCommandOnce(box, "probe", 10)).toEqual({ exitCode: 0, result: "ran 2" });
  expect(await executeSandboxCommandOnce(box, "other", 10)).toEqual({ exitCode: 0, result: "ran 3" });
  expect(box.commands).toEqual(["probe", "probe", "other"]);
});

test("a dropped prefetch is never handed out, and a failed one reaches only its taker", async () => {
  const box = sandbox(true);
  prefetchSandboxCommand(box, "probe", 10);
  prefetchSandboxCommand(box, "untaken", 10);
  await expect(executeSandboxCommandOnce(box, "probe", 10)).rejects.toThrow("sandbox unreachable");
  dropPrefetchedSandboxResults(box);
  expect(takePrefetchedSandboxResult(box, "untaken")).toBeNull();
});
