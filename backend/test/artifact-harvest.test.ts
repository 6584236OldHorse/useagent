import { describe, expect, test } from "bun:test";
// Importing the helpers boots the app on the throwaway database (schema included).
import "./helpers";
import { harvestTurnOutputs, type HarvestDependencies } from "../src/artifacts/harvest";
import { createRun, setRunSandbox } from "../src/runs/repo";
import { DEV_ORG_ID } from "../src/seed";

async function sandboxRun(prompt: string): Promise<string> {
  const runId = crypto.randomUUID();
  await createRun({
    id: runId, prompt, model: "m", engine: "mock", orgId: DEV_ORG_ID, userId: null,
    parentRunId: null, threadId: runId, repos: [], memoryScope: "org",
  });
  await setRunSandbox(runId, `sb-${runId}`, { kind: "daytona", credential: "env" });
  return runId;
}

const listing = (files: string) => async () => files;

describe("harvestTurnOutputs", () => {
  test("publishes new deliverables, revises a changed one, skips an unchanged one and a refused one", async () => {
    const runId = await sandboxRun("make a report");
    const published: Array<{ path: string; updates?: string }> = [];
    const deps: HarvestDependencies = {
      list: listing([
        "10\t5\t/root/work/out/report.pdf", "20\t5\t/root/work/secret.pdf", "30\t5\t/root/work/notes.md",
        "40\t5\t/root/work/same.md", "60\t5\t/root/work/diagram.png", "",
      ].join("\0")),
      known: async (_run, path) =>
        path.endsWith("notes.md") ? { id: "art-notes", sha256: "old", sizeBytes: 30, createdAt: new Date(0) }
        : path.endsWith("same.md") ? { id: "art-same", sha256: "same", sizeBytes: 40, createdAt: new Date(0) }
        : path.endsWith("diagram.png") ? { id: "art-png", sha256: "old", sizeBytes: 60, createdAt: new Date(0) }
        : null,
      digest: async (_run, path) => (path.endsWith("same.md") ? "same" : "new"),
      publish: async (input) => {
        if (input.path.endsWith("secret.pdf")) throw new Error("protected");
        if (input.path.endsWith("diagram.png") && input.updatesArtifactId) {
          throw new Error("republished file kind does not match the artifact being updated (expected document, got image)");
        }
        published.push({ path: input.path, updates: input.updatesArtifactId });
        expect(input).toMatchObject({ orgId: DEV_ORG_ID, runId, threadId: runId, purpose: "deliverable" });
        return { artifact: { id: `art-${published.length}` }, record: {}, created: true } as never;
      },
    };
    const ids = await harvestTurnOutputs(runId, {}, deps);
    expect(published).toEqual([
      { path: "/root/work/diagram.png", updates: undefined },
      { path: "/root/work/notes.md", updates: "art-notes" },
      { path: "/root/work/out/report.pdf", updates: undefined },
    ]);
    expect(ids).toEqual(["art-1", "art-2", "art-3"]);
  });

  test("an already cancelled run never starts any sandbox work", async () => {
    const runId = await sandboxRun("cancelled early");
    const controller = new AbortController();
    controller.abort();
    let listed = 0;
    const deps: HarvestDependencies = {
      list: async () => { listed += 1; return ""; },
      known: async () => null,
      digest: async () => "x",
      publish: async () => { throw new Error("unreachable"); },
    };
    expect(await harvestTurnOutputs(runId, { signal: controller.signal }, deps)).toEqual([]);
    expect(listed).toBe(0);
  });

  test("stops at once when the run is cancelled mid-way and never throws", async () => {
    const runId = await sandboxRun("cancelled");
    const controller = new AbortController();
    let listed = 0;
    const deps: HarvestDependencies = {
      list: async () => {
        listed += 1;
        controller.abort();
        return "10\t1\t/root/work/a.pdf\0";
      },
      known: async () => null,
      digest: async () => "x",
      publish: async () => { throw new Error("unreachable"); },
    };
    expect(await harvestTurnOutputs(runId, { signal: controller.signal }, deps)).toEqual([]);
    expect(listed).toBe(1);
  });

  test("gives up on a listing that never answers", async () => {
    const runId = await sandboxRun("stalled");
    const deps: HarvestDependencies = {
      list: () => new Promise(() => {}),
      known: async () => null,
      digest: async () => "x",
      publish: async () => { throw new Error("unreachable"); },
    };
    const controller = new AbortController();
    const pending = harvestTurnOutputs(runId, { signal: controller.signal }, deps);
    controller.abort();
    expect(await pending).toEqual([]);
  });

  test("a publish that started is finished even when the run is cancelled meanwhile", async () => {
    const runId = await sandboxRun("cancelled during publish");
    const controller = new AbortController();
    let published = 0;
    const deps: HarvestDependencies = {
      list: async () => "10\t2\t/root/work/a.pdf\0" + "20\t1\t/root/work/b.pdf\0",
      known: async () => null,
      digest: async () => "x",
      publish: async (input) => {
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 30));
        published += 1;
        return { artifact: { id: input.path }, record: {}, created: true } as never;
      },
    };
    expect(await harvestTurnOutputs(runId, { signal: controller.signal }, deps)).toEqual(["/root/work/a.pdf"]);
    expect(published).toBe(1);
  });

  test("unchanged files never use up the publication cap, and the newest file is examined first", async () => {
    const runId = await sandboxRun("many unchanged");
    const unchanged = Array.from({ length: 250 }, (_, i) => `10\t${100 + i}\t/root/work/a${String(i).padStart(3, "0")}.pdf`);
    const published: string[] = [];
    const deps: HarvestDependencies = {
      list: async () => [...unchanged, "10\t50\t/root/work/z-report.pdf", ""].join("\0"),
      known: async (_run, path) => (path.includes("/a") ? { id: `art-${path}`, sha256: "same", sizeBytes: 10, createdAt: new Date(0) } : null),
      digest: async () => "same",
      publish: async (input) => {
        published.push(input.path);
        return { artifact: { id: input.path }, record: {}, created: true } as never;
      },
    };
    expect(await harvestTurnOutputs(runId, {}, deps)).toEqual(["/root/work/z-report.pdf"]);
    expect(published).toEqual(["/root/work/z-report.pdf"]);
  });

  test("a file not modified since the thread stored it is skipped without reading it", async () => {
    const runId = await sandboxRun("mtime skip");
    let digests = 0;
    const deps: HarvestDependencies = {
      list: async () => "10\t1000\t/root/work/old.pdf\0",
      known: async () => ({ id: "art-old", sha256: "x", sizeBytes: 10, createdAt: new Date((1000 + 200) * 1000) }),
      digest: async () => { digests += 1; return "x"; },
      publish: async () => { throw new Error("unreachable"); },
    };
    expect(await harvestTurnOutputs(runId, {}, deps)).toEqual([]);
    expect(digests).toBe(0);
  });

  test("a cancellation during a revision attempt never starts the standalone fallback", async () => {
    const runId = await sandboxRun("cancelled in revision");
    const controller = new AbortController();
    const attempts: string[] = [];
    const deps: HarvestDependencies = {
      list: async () => "10\t1\t/root/work/diagram.png\0",
      known: async () => ({ id: "art-png", sha256: "old", sizeBytes: 99, createdAt: new Date(0) }),
      digest: async () => "x",
      publish: async (input) => {
        attempts.push(input.updatesArtifactId ? "revision" : "fresh");
        controller.abort();
        throw new Error("republished file kind does not match the artifact being updated (expected document)");
      },
    };
    expect(await harvestTurnOutputs(runId, { signal: controller.signal }, deps)).toEqual([]);
    expect(attempts).toEqual(["revision"]);
  });

  test("a cancellation that lands during the lookups stops before any publication starts", async () => {
    const runId = await sandboxRun("cancelled after lookup");
    const controller = new AbortController();
    let publishes = 0;
    const deps: HarvestDependencies = {
      list: async () => "10\t1\t/root/work/a.pdf\0",
      known: async () => {
        controller.abort();
        return null;
      },
      digest: async () => "x",
      publish: async () => {
        publishes += 1;
        return { artifact: { id: "never" }, record: {}, created: true } as never;
      },
    };
    expect(await harvestTurnOutputs(runId, { signal: controller.signal }, deps)).toEqual([]);
    expect(publishes).toBe(0);
  });

  test("does nothing for a run without a sandbox", async () => {
    const runId = crypto.randomUUID();
    await createRun({
      id: runId, prompt: "chat", model: "m", engine: "mock", orgId: DEV_ORG_ID, userId: null,
      parentRunId: null, threadId: runId, repos: [], memoryScope: "org",
    });
    let listed = false;
    const deps: HarvestDependencies = {
      list: async () => { listed = true; return ""; },
      known: async () => null,
      digest: async () => "x",
      publish: async () => { throw new Error("unreachable"); },
    };
    expect(await harvestTurnOutputs(runId, {}, deps)).toEqual([]);
    expect(listed).toBe(false);
    expect(await harvestTurnOutputs("missing-run", {}, deps)).toEqual([]);
  });
});
