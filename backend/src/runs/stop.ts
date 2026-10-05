// Stop is a turn-wide act: the run the reader stopped, and every run still
// working that the turn delegated: the threads it opened (and those threads'
// own delegations, all the way down) and the turns it handed to a bot inside
// an existing thread. Each is cancelled the durable way; the reader's run is
// what the response reports. Stopping a delegated thread never reaches its
// parent or its siblings, and a thread a person continued by hand is not
// delegation.
import { and, asc, eq, inArray, like } from "drizzle-orm";
import { acceptRunCancel, CANCEL_SUMMARY } from "../commands/cancel";
import { RUN_CREATE } from "../commands/repo";
import { db } from "../db/client";
import { botHandoffs, commands, runs, threadRelationships } from "../db/schema";
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
  /** The run was already settled when the cancel was recorded. */
  | { readonly kind: "terminal"; readonly runStatus: string }
  /** The cancel is recorded; `settledAs` when another party finalized the run meanwhile. */
  | { readonly kind: "cancelled" | "replay"; readonly settledAs?: string };

const LIVE_STATUSES = ["queued", "running"] as const;
// ponytail: bounded parameter lists per query; a recursive query if delegation trees ever get that wide
const QUERY_CHUNK = 500;
/** Passes over the delegation until one finds nothing new; a child can delegate until its own cancel commits. */
const MAX_PASSES = 25;

const runColumns = { id: runs.id, threadId: runs.threadId, status: runs.status };

async function runRow(orgId: string, runId: string): Promise<RunRow | null> {
  const [row] = await db.select(runColumns).from(runs).where(and(eq(runs.orgId, orgId), eq(runs.id, runId))).limit(1);
  return row ?? null;
}

async function runsWhere(orgId: string, where: ReturnType<typeof and>): Promise<RunRow[]> {
  return db
    .select(runColumns)
    .from(runs)
    .where(and(eq(runs.orgId, orgId), where))
    .orderBy(asc(runs.createdAt), asc(runs.id));
}

const live = (run: RunRow): boolean => (LIVE_STATUSES as readonly string[]).includes(run.status);

/** Record the cancel, then abort a live actor or settle a crash zombie. The thread is pumped by the caller once every run it holds is cancelled. */
async function cancelRun(input: StopInput, run: RunRow): Promise<CancelResult> {
  const outcome = await acceptRunCancel({ ...input, runId: run.id });
  if (outcome.status === "not_found") return { kind: "terminal", runStatus: run.status };
  if (outcome.status === "terminal") return { kind: "terminal", runStatus: outcome.runStatus };
  const kind = outcome.status === "already" ? "replay" : "cancelled";
  // What the run was when the cancel was recorded, not when it was listed: a
  // queued run was failed inside the cancel transaction; a running one is
  // aborted in process, and with no live actor it is a crash zombie, settled
  // now rather than left to recovery, on a repeated Stop as well.
  const status = outcome.status === "accepted" ? outcome.runStatusWas : (await runRow(input.orgId, run.id))?.status;
  if (status === "running" && !signalCancel(run.id, CANCEL_SUMMARY)) {
    const settledAs = await settleZombieCancel(run.id);
    if (settledAs) return { kind, settledAs };
  }
  return { kind };
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < items.length; start += QUERY_CHUNK) out.push(items.slice(start, start + QUERY_CHUNK));
  return out;
}

/** The threads these runs delegated, then everything delegated below them; a thread's index is its depth. */
async function delegatedThreads(orgId: string, roots: readonly RunRow[]): Promise<string[]> {
  const found = new Set<string>();
  let frontier: string[] = [];
  for (const root of roots) {
    const rows = await db
      .select({ threadId: threadRelationships.threadId })
      .from(threadRelationships)
      .where(and(
        eq(threadRelationships.orgId, orgId),
        eq(threadRelationships.kind, "delegated"),
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
        .where(and(
          eq(threadRelationships.orgId, orgId),
          eq(threadRelationships.kind, "delegated"),
          inArray(threadRelationships.parentThreadId, part),
        ));
      for (const { threadId } of rows) if (!found.has(threadId) && !next.includes(threadId)) next.push(threadId);
    }
    frontier = next;
  }
  return [...found];
}

/** Turns this run handed to a bot inside an existing thread, whatever their state now: the bot threads this thread ever handed to are few, and the command that created each turn carries the source run. */
async function handoffRuns(orgId: string, root: RunRow): Promise<RunRow[]> {
  const botThreads = (
    await db
      .select({ threadId: botHandoffs.threadId })
      .from(botHandoffs)
      .where(and(eq(botHandoffs.orgId, orgId), eq(botHandoffs.parentThreadId, root.threadId)))
  ).map((row) => row.threadId);
  if (botThreads.length === 0) return [];
  const ids: string[] = [];
  for (const part of chunks(botThreads)) {
    const rows = await db
      .select({ runId: commands.runId, payload: commands.payload })
      .from(commands)
      .where(and(
        eq(commands.orgId, orgId),
        eq(commands.kind, RUN_CREATE),
        inArray(commands.threadId, part),
        like(commands.payload, `%${root.id}%`),
      ));
    for (const { runId, payload } of rows) {
      if (!runId || !payload) continue;
      try {
        const provenance = (JSON.parse(payload) as { botHandoff?: { kind?: unknown; sourceRunId?: unknown } }).botHandoff;
        if (provenance?.kind === "bot_handoff_followup" && provenance.sourceRunId === root.id) ids.push(runId);
      } catch {
        // audit text that is not JSON is not provenance
      }
    }
  }
  const found: RunRow[] = [];
  for (const part of chunks(ids)) found.push(...await runsWhere(orgId, inArray(runs.id, part)));
  return found;
}

/** Live runs the stopped turn delegated, nearest first: handoffs and first-level threads, then deeper threads; queued before running everywhere, so nothing queued is dispatched behind a signalled run. */
async function liveDelegatedRuns(orgId: string, root: RunRow): Promise<RunRow[]> {
  const handoffs = await handoffRuns(orgId, root);
  const threads = await delegatedThreads(orgId, [root, ...handoffs]);
  const depth = new Map(threads.map((id, index) => [id, index + 1]));
  const found: RunRow[] = handoffs.filter(live);
  for (const part of chunks(threads)) {
    found.push(...await runsWhere(orgId, and(inArray(runs.threadId, part), inArray(runs.status, LIVE_STATUSES))));
  }
  const rank = (run: RunRow) => (run.status === "queued" ? 0 : 1_000_000) + (depth.get(run.threadId) ?? 0);
  return found.toSorted((a, b) => rank(a) - rank(b));
}

export async function stopRun(input: StopInput): Promise<StopOutcome> {
  const root = await runRow(input.orgId, input.runId);
  if (!root) return { status: "not_found" };
  const rootResult = await cancelRun(input, root);
  if (rootResult.kind === "terminal") return { status: "settled", runStatus: rootResult.runStatus };

  // Every delegated run is cancelled before any thread is pumped, so a pump
  // cannot start a queued follow-up that is about to be cancelled. A queued
  // run whose cancel failed keeps its thread's running actors unsignalled
  // (their teardown would pump it) and its thread unpumped; it is tried
  // again on the next pass. Passes continue until one finds nothing new.
  const touched = new Set([root.threadId]);
  const handled = new Set<string>();
  const failed = new Map<string, string>();
  let children = 0;
  for (let pass = 0; ; pass += 1) {
    if (pass === MAX_PASSES) {
      console.warn(`[stop] ${input.runId}: delegation still changing after ${MAX_PASSES} passes; a later Stop picks up the rest`);
      break;
    }
    const fresh = (await liveDelegatedRuns(input.orgId, root)).filter((run) => !handled.has(run.id));
    if (fresh.length === 0) break;
    const blocked = new Set<string>();
    let progressed = false;
    for (const run of fresh) {
      if (run.status === "running" && blocked.has(run.threadId)) continue;
      try {
        const result = await cancelRun(input, run);
        handled.add(run.id);
        failed.delete(run.id);
        touched.add(run.threadId);
        progressed = true;
        if (result.kind === "cancelled") children += 1;
      } catch (error) {
        failed.set(run.id, run.threadId);
        if (run.status === "queued") blocked.add(run.threadId);
        console.warn(`[stop] delegated run ${run.id} was not cancelled with ${input.runId}:`, error);
      }
    }
    if (!progressed) break;
  }
  const held = new Set(failed.values());
  for (const threadId of touched) if (!held.has(threadId)) await pumpThread(threadId);
  if (rootResult.settledAs) return { status: "settled", runStatus: rootResult.settledAs };
  return { status: "cancelling", replay: rootResult.kind === "replay", children };
}
