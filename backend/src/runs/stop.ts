// Stop is a turn-wide act: the run the reader stopped, and every run still
// working that the turn delegated: the threads it opened (and those threads'
// own delegations, all the way down) and the bot handoffs it made into an
// existing thread. Each is cancelled the durable way; the reader's run is what
// the response reports. Stopping a delegated thread never reaches its parent
// or its siblings.
import { and, asc, eq, inArray, like } from "drizzle-orm";
import { acceptRunCancel, CANCEL_SUMMARY } from "../commands/cancel";
import { RUN_CREATE } from "../commands/repo";
import { db } from "../db/client";
import { commands, runs, threadRelationships } from "../db/schema";
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
/** Passes over the delegation: a cancel that failed, or a run that was still finalizing, gets another look. */
const RESCAN_PASSES = 3;

async function runRow(orgId: string, runId: string): Promise<RunRow | null> {
  const [row] = await db
    .select({ id: runs.id, threadId: runs.threadId, status: runs.status })
    .from(runs)
    .where(and(eq(runs.orgId, orgId), eq(runs.id, runId)))
    .limit(1);
  return row ?? null;
}

async function liveRuns(orgId: string, where: ReturnType<typeof and>): Promise<RunRow[]> {
  return db
    .select({ id: runs.id, threadId: runs.threadId, status: runs.status })
    .from(runs)
    .where(and(eq(runs.orgId, orgId), inArray(runs.status, LIVE_STATUSES), where))
    .orderBy(asc(runs.createdAt), asc(runs.id));
}

/** Record the cancel, then abort a live actor or settle a crash zombie. The thread is pumped by the caller once every run it holds is cancelled. */
async function cancelRun(input: StopInput, run: RunRow): Promise<CancelResult> {
  const outcome = await acceptRunCancel({ ...input, runId: run.id });
  if (outcome.status === "not_found") return { kind: "settled", runStatus: run.status };
  if (outcome.status === "terminal") return { kind: "settled", runStatus: outcome.runStatus };
  // What the run was when the cancel was recorded, not when it was listed: a
  // queued run was failed inside the cancel transaction; a running one is
  // aborted in process, and with no live actor it is a crash zombie, settled
  // now rather than left to recovery, on a repeated Stop as well.
  const status = outcome.status === "accepted" ? outcome.runStatusWas : (await runRow(input.orgId, run.id))?.status;
  if (status === "running" && !signalCancel(run.id, CANCEL_SUMMARY)) {
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

/** The threads these runs delegated, then everything below them; a thread's index is its depth. */
async function delegatedThreads(orgId: string, roots: readonly RunRow[]): Promise<string[]> {
  const found = new Set<string>();
  let frontier: string[] = [];
  for (const root of roots) {
    const rows = await db
      .select({ threadId: threadRelationships.threadId })
      .from(threadRelationships)
      .where(and(
        eq(threadRelationships.orgId, orgId),
        eq(threadRelationships.parentThreadId, root.threadId),
        eq(threadRelationships.sourceRunId, root.id),
      ));
    for (const { threadId } of rows) if (!frontier.includes(threadId)) frontier.push(threadId);
  }
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

/** Turns this run handed to a bot inside an existing thread; the command that created each carries the source run. */
async function handoffRuns(orgId: string, root: RunRow): Promise<RunRow[]> {
  const rows = await db
    .select({ runId: commands.runId, payload: commands.payload })
    .from(commands)
    .where(and(eq(commands.orgId, orgId), eq(commands.kind, RUN_CREATE), like(commands.payload, `%${root.id}%`)));
  const ids = rows.flatMap(({ runId, payload }) => {
    if (!runId || !payload) return [];
    try {
      const provenance = (JSON.parse(payload) as { botHandoff?: { kind?: unknown; sourceRunId?: unknown } }).botHandoff;
      return provenance?.kind === "bot_handoff_followup" && provenance.sourceRunId === root.id ? [runId] : [];
    } catch {
      return [];
    }
  });
  const live: RunRow[] = [];
  for (const part of chunks(ids)) live.push(...await liveRuns(orgId, inArray(runs.id, part)));
  return live;
}

/** Live runs the stopped turn delegated, nearest first: handoffs and first-level threads, then deeper threads; oldest run first within a thread, queued before running so nothing is dispatched behind a signalled run. */
async function liveDelegatedRuns(orgId: string, root: RunRow): Promise<RunRow[]> {
  const handoffs = await handoffRuns(orgId, root);
  const threads = await delegatedThreads(orgId, [root, ...handoffs]);
  const depth = new Map(threads.map((id, index) => [id, index + 1]));
  const live: RunRow[] = handoffs;
  for (const part of chunks(threads)) live.push(...await liveRuns(orgId, inArray(runs.threadId, part)));
  const rank = (run: RunRow) => (depth.get(run.threadId) ?? 0) * 2 + (run.status === "queued" ? 0 : 1);
  return live.toSorted((a, b) => rank(a) - rank(b));
}

export async function stopRun(input: StopInput): Promise<StopOutcome> {
  const root = await runRow(input.orgId, input.runId);
  if (!root) return { status: "not_found" };
  const rootResult = await cancelRun(input, root);
  if (rootResult.kind === "settled") return { status: "settled", runStatus: rootResult.runStatus };

  // Every delegated run is cancelled before any thread is pumped, so a pump
  // cannot start a queued follow-up that is about to be cancelled. A child
  // whose cancel failed is logged, tried again on the next pass, and its
  // thread is not pumped by this Stop.
  const touched = new Set([root.threadId]);
  const held = new Set<string>();
  const handled = new Set<string>();
  let children = 0;
  for (let pass = 0; pass < RESCAN_PASSES; pass += 1) {
    const fresh = (await liveDelegatedRuns(input.orgId, root)).filter((run) => !handled.has(run.id));
    if (fresh.length === 0) break;
    for (const run of fresh) {
      try {
        const result = await cancelRun(input, run);
        handled.add(run.id);
        touched.add(run.threadId);
        held.delete(run.threadId);
        if (result.kind === "cancelled") children += 1;
      } catch (error) {
        held.add(run.threadId);
        console.warn(`[stop] delegated run ${run.id} was not cancelled with ${input.runId}:`, error);
      }
    }
  }
  for (const threadId of touched) if (!held.has(threadId)) await pumpThread(threadId);
  return { status: "cancelling", replay: rootResult.kind === "replay", children };
}
