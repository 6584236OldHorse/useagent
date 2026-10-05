import { expect, spyOn, test } from "bun:test";
import * as runsRepo from "../src/runs/repo";
import { attachRunFeed } from "../src/connectors/runFeed";
import { watchSlackRun } from "../src/slack/watcher";
import { bus, channel, type BusEvent } from "../src/worker";

// Every Slack message and email attaches a live watcher whose race check reads
// the run once. A failed read (a DB blip) must stay a logged warning: an
// unhandled rejection exits the backend and ends every live turn with it.
test("a failed race check in the Slack watcher and the run feed never rejects unhandled", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  const read = spyOn(runsRepo, "getRun").mockRejectedValue(new Error("connection lost"));
  const warned = spyOn(console, "warn").mockImplementation(() => {});
  let raceWarnings = 0;
  try {
    const runId = crypto.randomUUID();
    watchSlackRun({ runId, rootRunId: runId, orgId: "org-race", teamId: "T-race", channel: "C-race", threadTs: "1.0" });
    let done: string | undefined;
    attachRunFeed(runId, {
      channelType: "test",
      onTextChunk: () => {},
      onThinking: () => {},
      onToolCall: () => {},
      onCompaction: () => {},
      onDone: (status) => { done = status; },
    });
    await Bun.sleep(25);
    // Background loops in the shared test process may read other runs; count this run's reads only.
    expect(read.mock.calls.filter(([id]) => id === runId)).toHaveLength(2);
    raceWarnings = warned.mock.calls.filter(([message]) => String(message).includes("race check")).length;
    // The run's end event still settles both.
    bus.emit(channel(runId), { type: "end", status: "failed" } satisfies BusEvent);
    await Bun.sleep(5);
    expect(done).toBe("failed");
  } finally {
    warned.mockRestore();
    read.mockRestore();
    process.off("unhandledRejection", onUnhandled);
  }
  expect(raceWarnings).toBe(2);
  expect(unhandled).toEqual([]);
});
