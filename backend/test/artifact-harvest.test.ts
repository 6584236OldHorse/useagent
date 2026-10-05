import { describe, expect, test } from "bun:test";
import { harvestTurnOutputs } from "../src/artifacts/harvest";
import { createRun, setRunSandbox } from "../src/runs/repo";
// Importing the helpers boots the app on the throwaway database (schema included).
import "./helpers";
import { DEV_ORG_ID } from "../src/seed";

describe("harvestTurnOutputs", () => {
  test("publishes each deliverable the workspace listing reports and survives a refused file", async () => {
    const runId = crypto.randomUUID();
    await createRun({
      id: runId, prompt: "make a report", model: "m", engine: "mock", orgId: DEV_ORG_ID, userId: null,
      parentRunId: null, threadId: runId, repos: [], memoryScope: "org",
    });
    await setRunSandbox(runId, "sb-harvest", { kind: "daytona", credential: "env" });
    const published: string[] = [];
    const ids = await harvestTurnOutputs(runId, {
      listing: async (run, root) => {
        expect(run.id).toBe(runId);
        return [`10\t${root}/out/report.pdf`, `20\t${root}/secret.pdf`, `30\t${root}/notes.md`, "", "--repos--"].join("\n");
      },
      publish: async (input) => {
        if (input.path.endsWith("secret.pdf")) throw new Error("protected");
        published.push(input.path);
        expect(input).toMatchObject({ orgId: DEV_ORG_ID, runId, threadId: runId, purpose: "deliverable" });
        return { artifact: { id: `art-${published.length}` }, record: {}, created: true } as never;
      },
    });
    expect(published.map((p) => p.split("/").at(-1))).toEqual(["notes.md", "report.pdf"]);
    expect(ids).toEqual(["art-1", "art-2"]);
  });

  test("does nothing for a run without a sandbox and never throws", async () => {
    const runId = crypto.randomUUID();
    await createRun({
      id: runId, prompt: "chat", model: "m", engine: "mock", orgId: DEV_ORG_ID, userId: null,
      parentRunId: null, threadId: runId, repos: [], memoryScope: "org",
    });
    let listed = false;
    const ids = await harvestTurnOutputs(runId, {
      listing: async () => { listed = true; return ""; },
      publish: async () => { throw new Error("unreachable"); },
    });
    expect(ids).toEqual([]);
    expect(listed).toBe(false);
    expect(await harvestTurnOutputs("missing-run", { listing: async () => "", publish: async () => { throw new Error("x"); } })).toEqual([]);
  });
});
