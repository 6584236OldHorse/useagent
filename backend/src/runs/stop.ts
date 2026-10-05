// Stop is a thread-wide act. The run the reader stopped is cancelled the
// durable way, and so is every run still working in a thread this thread
// delegated to (children, their children, and so on). Stopping a child never
// reaches its parent.
import { and, asc, eq, inArray } from "drizzle-orm";
import { acceptRunCancel, CANCEL_SUMMARY } from "../commands/cancel";
import { db } from "../db/client";
import { runs, threadRelationships } from "../db/schema";
import { pumpThread, signalCancel } from "../worker";
import { settleZombieCancel } from "./zombie-cancel";

export type StopOutcome =
  | { readonly status: "not_found" }
  /** The run had already settled; `runStatus` is what the record holds. */
  | { readonly status: "settled"; readonly runStatus: string }
  /** `replay` is a repeated Stop; `children` counts delegated runs newly stopped with it. */
  | { readonly status: "cancelling"; readonly replay: boolean; readonly children: number };

interface StopInput {
  readonly orgId: string;
  readonly actorId: string | null;
  readonly runId: string;
}

/** Record the cancel, signal a live actor or settle a crash zombie, and pump the thread so the next queued turn dispatches. */
async function cancelOne(input: StopInput): Promise<StopOutcome & { readonly threadId?: string }> {
  const outcome = await acceptRunCancel(input);
  switch (outcome.status) {
    case "not_found":
      return outcome;
    case "terminal":
      return { status: "settled", runStatus: outcome.runStatus };
    case "already":
      signalCancel(input.runId, CANCEL_SUMMARY);
      await pumpThread(outcome.threadId);
      return { status: "cancelling", replay: true, children: 0, threadId: outcome.threadId };
    case "accepted":
      // A queued run was already failed in the cancel transaction. A running
      // one is aborted in process; with no live actor it is a crash zombie,
      // settled now rather than left to recovery.
      if (outcome.runStatusWas === "running" && !signalCancel(input.runId, CANCEL_SUMMARY)) {
        const durableStatus = await settleZombieCancel(input.runId);
        if (durableStatus) {
          await pumpThread(outcome.threadId);
          return { status: "settled", runStatus: durableStatus };
        }
      }
      await pumpThread(outcome.threadId);
      return { status: "cancelling", replay: false, children: 0, threadId: outcome.threadId };
  }
}

/** Every thread below this one in the delegation tree, nearest first. */
async function delegatedThreads(orgId: string, threadId: string): Promise<string[]> {
  const found: string[] = [];
  let frontier = [threadId];
  while (frontier.length > 0) {
    const rows = await db
      .select({ threadId: threadRelationships.threadId })
      .from(threadRelationships)
      .where(and(eq(threadRelationships.orgId, orgId), inArray(threadRelationships.parentThreadId, frontier)));
    frontier = rows.map((row) => row.threadId).filter((id) => !found.includes(id));
    found.push(...frontier);
  }
  return found;
}

async function liveDelegatedRuns(orgId: string, threadId: string): Promise<readonly string[]> {
  const threads = await delegatedThreads(orgId, threadId);
  if (threads.length === 0) return [];
  const rows = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.orgId, orgId), inArray(runs.threadId, threads), inArray(runs.status, ["queued", "running"])))
    .orderBy(asc(runs.createdAt), asc(runs.id));
  return rows.map((row) => row.id);
}

export async function stopRun(input: StopInput): Promise<StopOutcome> {
  const { threadId, ...outcome } = await cancelOne(input);
  if (outcome.status !== "cancelling" || !threadId) return outcome;
  let children = 0;
  for (const runId of await liveDelegatedRuns(input.orgId, threadId)) {
    const child = await cancelOne({ ...input, runId });
    if (child.status === "cancelling" && !child.replay) children += 1;
  }
  return { ...outcome, children };
}
