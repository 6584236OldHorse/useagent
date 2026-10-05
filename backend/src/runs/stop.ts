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

/** Record the cancel. What the run was when the cancel was recorded, not when it was listed: a queued run was failed inside the cancel transaction; a running one still has to be signalled. */
async function recordCancel(input: StopInput, run: RunRow): Promise<CancelResult & { readonly status?: string }> {
  const outcome = await acceptRunCancel({ ...input, runId: run.id });
  if (outcome.status === "not_found") return { kind: "terminal", runStatus: run.status };
  if (outcome.status === "terminal") return { kind: "terminal", runStatus: outcome.runStatus };
  const kind = outcome.status === "already" ? "replay" : "cancelled";
  const status = outcome.status === "accepted" ? outcome.runStatusWas : (await runRow(input.orgId, run.id))?.status;
  return { kind, status };
}

/** Abort a live actor, or settle a crash zombie now rather than leave it to recovery, on a repeated Stop as well. Returns the status another party settled the run with meanwhile. */
async function signalRun(run: RunRow): Promise<string | undefined> {
  if (signalCancel(run.id, CANCEL_SUMMARY)) return undefined;
  return (await settleZombieCancel(run.id)) ?? undefined;
}

/** Record and signal in one step; the reader's own run takes this path. */
async function cancelRun(input: StopInput, run: RunRow): Promise<CancelResult> {
  const recorded = await recordCancel(input, run);
  if (recorded.kind === "terminal" || recorded.status !== "running") return recorded;
  const settledAs = await signalRun(run);
  return settledAs ? { kind: recorded.kind, settledAs } : { kind: recorded.kind };
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

/** Turns these runs handed to a bot inside an existing thread, whatever their state now: the bot threads a thread ever handed to are few, and the command that created each turn carries the source run. */
async function handoffRuns(orgId: string, sources: readonly RunRow[]): Promise<RunRow[]> {
  const found: RunRow[] = [];
  for (const source of sources) {
    const botThreads = (
      await db
        .select({ threadId: botHandoffs.threadId })
        .from(botHandoffs)
        .where(and(eq(botHandoffs.orgId, orgId), eq(botHandoffs.parentThreadId, source.threadId)))
    ).map((row) => row.threadId);
    const ids: string[] = [];
    for (const part of chunks(botThreads)) {
      const rows = await db
        .select({ runId: commands.runId, payload: commands.payload })
        .from(commands)
        .where(and(
          eq(commands.orgId, orgId),
          eq(commands.kind, RUN_CREATE),
          inArray(commands.threadId, part),
          like(commands.payload, `%${source.id}%`),
        ));
      for (const { runId, payload } of rows) {
        if (!runId || !payload) continue;
        try {
          const provenance = (JSON.parse(payload) as { botHandoff?: { kind?: unknown; sourceRunId?: unknown } }).botHandoff;
          if (provenance?.kind === "bot_handoff_followup" && provenance.sourceRunId === source.id) ids.push(runId);
        } catch {
          // audit text that is not JSON is not provenance
        }
      }
    }
    for (const part of chunks(ids)) found.push(...await runsWhere(orgId, inArray(runs.id, part)));
  }
  return found;
}

/** Everything the stopped turn delegated, to a fixed point: the threads it opened and the handoffs it made, then what every run in those did in turn, whatever state those runs are in now. A thread's index is its depth. */
async function delegation(orgId: string, root: RunRow): Promise<{ runs: RunRow[]; depth: Map<string, number> }> {
  const known = new Map<string, RunRow>([[root.id, root]]);
  const depth = new Map<string, number>();
  let sources: RunRow[] = [root];
  while (sources.length > 0) {
    const fresh: RunRow[] = [];
    const add = (run: RunRow) => {
      if (known.has(run.id)) return;
      known.set(run.id, run);
      fresh.push(run);
    };
    for (const run of await handoffRuns(orgId, sources)) add(run);
    const threads = (await delegatedThreads(orgId, sources)).filter((id) => !depth.has(id));
    for (const [index, id] of threads.entries()) depth.set(id, depth.size + index + 1);
    for (const part of chunks(threads)) for (const run of await runsWhere(orgId, inArray(runs.threadId, part))) add(run);
    sources = fresh;
  }
  known.delete(root.id);
  return { runs: [...known.values()], depth };
}

/** Live runs the stopped turn delegated, nearest first; queued before running everywhere, so nothing queued is dispatched behind a signalled run. */
async function liveDelegatedRuns(orgId: string, root: RunRow): Promise<RunRow[]> {
  const found = await delegation(orgId, root);
  const rank = (run: RunRow) => (run.status === "queued" ? 0 : 1_000_000) + (found.depth.get(run.threadId) ?? 0);
  return found.runs.filter(live).toSorted((a, b) => rank(a) - rank(b));
}

export async function stopRun(input: StopInput): Promise<StopOutcome> {
  const root = await runRow(input.orgId, input.runId);
  if (!root) return { status: "not_found" };
  const rootResult = await cancelRun(input, root);
  if (rootResult.kind === "terminal") return { status: "settled", runStatus: rootResult.runStatus };

  // Every cancel in a pass is recorded before any actor in it is signalled:
  // a signalled actor's teardown pumps its thread, and whatever it would
  // dispatch is already settled by then. A run whose cancel failed keeps its
  // thread's actors unsignalled and its thread unpumped, and is tried again
  // on the next pass; a signal held back stays owed until it is delivered.
  // Passes continue until one finds nothing new.
  const touched = new Set([root.threadId]);
  const handled = new Set<string>();
  const failed = new Map<string, string>();
  const owedSignals = new Map<string, RunRow>();
  let children = 0;
  const signalOwed = async (blocked: ReadonlySet<string>) => {
    for (const run of [...owedSignals.values()]) {
      if (blocked.has(run.threadId)) continue;
      try {
        await signalRun(run);
        owedSignals.delete(run.id);
      } catch (error) {
        console.warn(`[stop] delegated run ${run.id} could not be signalled yet:`, error);
      }
    }
  };
  for (let pass = 0; ; pass += 1) {
    if (pass === MAX_PASSES) {
      console.warn(`[stop] ${input.runId}: delegation still changing after ${MAX_PASSES} passes; a later Stop picks up the rest`);
      break;
    }
    const fresh = (await liveDelegatedRuns(input.orgId, root)).filter((run) => !handled.has(run.id));
    if (fresh.length === 0 && owedSignals.size === 0) break;
    const blocked = new Set<string>();
    let progressed = false;
    for (const run of fresh) {
      try {
        const recorded = await recordCancel(input, run);
        handled.add(run.id);
        failed.delete(run.id);
        touched.add(run.threadId);
        progressed = true;
        if (recorded.kind === "cancelled") children += 1;
        if (recorded.kind !== "terminal" && recorded.status === "running") owedSignals.set(run.id, run);
      } catch (error) {
        failed.set(run.id, run.threadId);
        blocked.add(run.threadId);
        console.warn(`[stop] delegated run ${run.id} was not cancelled with ${input.runId}:`, error);
      }
    }
    const owedBefore = owedSignals.size;
    await signalOwed(blocked);
    if (owedSignals.size < owedBefore) progressed = true;
    if (!progressed) break;
  }
  // A signal still owed because a queued cancel in its thread kept failing is
  // delivered anyway: a running actor nobody stops is worse than a pump.
  await signalOwed(new Set());
  const held = new Set(failed.values());
  for (const threadId of touched) if (!held.has(threadId)) await pumpThread(threadId);
  if (rootResult.settledAs) return { status: "settled", runStatus: rootResult.settledAs };
  return { status: "cancelling", replay: rootResult.kind === "replay", children };
}
