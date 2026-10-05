// Stop is a turn-wide act: the run the reader stopped, and every run still
// working in a thread that turn delegated (and those threads' own delegations,
// all the way down). Each is cancelled the durable way; the reader's run is
// what the response reports. Stopping a delegated thread never reaches its
// parent or its siblings.
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

interface RunRow {
  readonly id: string;
  readonly threadId: string;
  readonly status: string;
}

type CancelResult =
  | { readonly kind: "cancelled" | "replay" }
  | { readonly kind: "settled"; readonly runStatus: string };

const LIVE_STATUSES = ["queued", "running"] as const;
// ponytail: bounded parameter lists per query; a recursive query if delegation trees ever get that wide
const QUERY_CHUNK = 500;
/** Passes over the delegation tree: a child created while the first pass ran is caught by the next. */
const RESCAN_PASSES = 3;

async function runRow(orgId: string, runId: string): Promise<RunRow | null> {
  const [row] = await db
    .select({ id: runs.id, threadId: runs.threadId, status: runs.status })
    .from(runs)
    .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)))
    .limit(1);
  return row ?? null;
}

/** Record the cancel, then abort a live actor or settle a crash zombie. The thread is pumped by the caller once every run it holds is cancelled. */
async function cancelRun(input: StopInput, run: RunRow): Promise<CancelResult> {
  const outcome = await acceptRunCancel({ ...input, runId: run.id });
  if (outcome.status === "not_found") return { kind: "settled", runStatus: run.status };
  if (outcome.status === "terminal") return { kind: "settled", runStatus: outcome.runStatus };
  // A queued run was failed inside the cancel transaction. A running one is
  // aborted in process; with no live actor it is a crash zombie, settled now
  // rather than left to recovery, on a repeated Stop as well.
  if (run.status === "running" && !signalCancel(run.id, CANCEL_SUMMARY)) {
    const durableStatus = await settleZombieCancel(run.id);
    if (durableStatus) return { kind: "settled", runStatus: durableStatus };
  }
  return { kind: outcome.status === "already" ? "replay" : "cancelled" };
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += QUERY_CHUNK) out.push(items.slice(start, start + QUERY_CHUNK));
  return out;
}

/** The threads this run delegated, then everything below them; a thread's index is its depth. */
async function delegatedThreads(orgId: string, root: RunRow): Promise<string[]> {
  const found = new Set<string>();
  let frontier = (
    await db
      .select({ threadId: threadRelationships.threadId })
      .from(threadRelationships)
      .where(and(
        eq(threadRelationships.orgId, orgId),
        eq(threadRelationships.parentThreadId, root.threadId),
        eq(threadRelationships.sourceRunId, root.id),
      ))
  ).map((row) => row.threadId);
  while (frontier.length > 0) {
    for (const id of frontier) found.add(id);
    const next: string[] = [];
    for (const part of chunks(frontier)) {
      const rows = await db
        .select({ threadId: threadRelationships.threadId })
        .from(threadRelationships)
        .where(and(eq(threadRelationships.orgId, orgId), inArray(threadRelationships.parentThreadId, part)));
      for (const { threadId } of rows) if (!found.has(threadId) && !next.includes(threadId)) next.push(threadId);
    }
    frontier = next;
  }
  return [...found];
}

/** Live runs in the delegated threads, nearest thread first and oldest run first within a thread. */
async function liveDelegatedRuns(orgId: string, root: RunRow): Promise<RunRow[]> {
  const threads = await delegatedThreads(orgId, root);
  const depth = new Map(threads.map((id, index) => [id, index]));
  const live: RunRow[] = [];
  for (const part of chunks(threads)) {
    live.push(...await db
      .select({ id: runs.id, threadId: runs.threadId, status: runs.status })
      .from(runs)
      .where(and(eq(runs.orgId, orgId), inArray(runs.threadId, part), inArray(runs.status, LIVE_STATUSES)))
      .orderBy(asc(runs.createdAt), asc(runs.id)));
  }
  return live.toSorted((a, b) => depth.get(a.threadId)! - depth.get(b.threadId)!);
}

export async function stopRun(input: StopInput): Promise<StopOutcome> {
  const root = await runRow(input.orgId, input.runId);
  if (!root) return { status: "not_found" };
  const rootResult = await cancelRun(input, root);
  if (rootResult.kind === "settled") return { status: "settled", runStatus: rootResult.runStatus };

  // Every delegated run is cancelled before any thread is pumped, so a pump
  // cannot start a queued follow-up that is about to be cancelled. A child
  // whose cancel failed is logged and left for the next Stop.
  const touched = new Set([root.threadId]);
  const handled = new Set<string>();
  let children = 0;
  for (let pass = 0; pass < RESCAN_PASSES; pass += 1) {
    const fresh = (await liveDelegatedRuns(input.orgId, root)).filter((run) => !handled.has(run.id));
    if (fresh.length === 0) break;
    for (const run of fresh) {
      handled.add(run.id);
      touched.add(run.threadId);
      try {
        if ((await cancelRun(input, run)).kind === "cancelled") children += 1;
      } catch (error) {
        console.warn(`[stop] delegated run ${run.id} was not cancelled with ${input.runId}:`, error);
      }
    }
  }
  for (const threadId of touched) await pumpThread(threadId);
  return { status: "cancelling", replay: rootResult.kind === "replay", children };
}
