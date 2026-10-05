import { describe, expect, test } from "bun:test";
import "./helpers";
import {
  discoverTurnOutputs,
  recordOutputBaseline,
  type DiscoveryDependencies,
} from "../src/artifacts/harvest";
import { createRun, getRun, setRunSandbox } from "../src/runs/repo";
import type { SandboxHandle } from "../src/sandboxes/provider";
import { DEV_ORG_ID } from "../src/seed";

const complete = (records = "") => `${records}__USEAGENT_LISTING_COMPLETE__\0`;

async function sandboxRun(): Promise<NonNullable<Awaited<ReturnType<typeof getRun>>>> {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId,
    prompt: "make a report",
    model: "m",
    engine: "mock",
    orgId: DEV_ORG_ID,
    userId: null,
    parentRunId: null,
    threadId: runId,
    repos: [],
    memoryScope: "org",
  });
  await setRunSandbox(runId, `sb-${runId}`, { kind: "daytona", credential: "env" });
  return (await getRun(runId))!;
}

function clockSandbox(id: string, timestamps: string[]): SandboxHandle {
  return {
    id,
    process: {
      async executeCommand(command: string) {
        expect(command).toBe("date +%s.%N");
        return { exitCode: 0, result: timestamps.shift() };
      },
    },
  } as SandboxHandle;
}

describe("automatic artifact discovery", () => {
  test("uses the immutable first sandbox-clock baseline and returns candidates only", async () => {
    const run = await sandboxRun();
    const sandbox = clockSandbox(run.sandboxId!, ["1757000000.100000000\n", "1757000001.200000000\n"]);
    await recordOutputBaseline(run.id, sandbox, "/root/work");
    await recordOutputBaseline(run.id, sandbox, "/root/work");

    const commands: string[] = [];
    const deps: DiscoveryDependencies = {
      list: async (_run, command) => {
        commands.push(command);
        return command.includes("-name .git")
          ? complete("/root/work/repo\0")
          : complete("12\t/root/work/report.txt\0" + "9\t/root/work/repo/code.json\0");
      },
    };
    expect(await discoverTurnOutputs(run, {}, deps)).toEqual([
      { path: "/root/work/report.txt", size: 12 },
    ]);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toContain("-newerct '@1757000000.100000000'");
  });

  test("returns no automatic candidates without a baseline and never lists", async () => {
    const run = await sandboxRun();
    let listed = false;
    expect(await discoverTurnOutputs(run, {}, {
      list: async () => {
        listed = true;
        return complete();
      },
    })).toEqual([]);
    expect(listed).toBe(false);
  });

  test("throws on baseline binding mismatch and listing failure", async () => {
    const run = await sandboxRun();
    await recordOutputBaseline(run.id, clockSandbox(run.sandboxId!, ["1757000000.1"]), "/root/work");
    await setRunSandbox(run.id, `replacement-${run.id}`, { kind: "daytona", credential: "env" });
    const rebound = (await getRun(run.id))!;
    await expect(discoverTurnOutputs(rebound, {}, {
      list: async () => complete(),
    })).rejects.toThrow("sandbox mismatch");

    const current = await sandboxRun();
    await recordOutputBaseline(current.id, clockSandbox(current.sandboxId!, ["1757000000.2"]), "/root/work");
    await expect(discoverTurnOutputs(current, {}, {
      list: async () => "",
    })).rejects.toThrow("incomplete");
  });

  test("honors cancellation before invoking sandbox work", async () => {
    const run = await sandboxRun();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    let executed = false;
    const sandbox = {
      id: run.sandboxId!,
      process: {
        async executeCommand() {
          executed = true;
          return { exitCode: 0, result: "1757000000.3" };
        },
      },
    } as SandboxHandle;
    await expect(recordOutputBaseline(run.id, sandbox, "/root/work", controller.signal))
      .rejects.toThrow("cancelled");
    expect(executed).toBe(false);
  });
});
