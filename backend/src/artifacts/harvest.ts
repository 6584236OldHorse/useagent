/**
 * Turn output harvest: the plane looks at the workspace itself instead of
 * waiting for the agent to call the publish tool. After a sandbox turn, every
 * deliverable file the agent created or changed during the turn (documents,
 * spreadsheets, decks, media, archives) becomes an artifact through the same
 * trusted path the publish tool uses, so the session files rail, the thread's
 * Slack uploads and the artifact hub all see it. Files inside cloned
 * repositories are code changes, not deliverables, and stay out; a file the
 * thread already holds with the same bytes is skipped, and a changed file
 * becomes a new revision of the thread's artifact where the kinds allow it.
 */
import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { artifacts } from "../db/schema";
import { getRun } from "../runs/repo";
import { resolveRunSandbox } from "../sandboxes/binding";
import { resolveAttachedSandboxWorkspaceRoot } from "../sandboxes/workspace";
import { downloadSandboxFile } from "../slack/sandbox-file";
import { MAX_ARTIFACT_BYTES, publishSandboxArtifact } from "./publish";

/** File types worth keeping as durable outputs of a turn. */
const DELIVERABLE_EXTENSIONS = [
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "md", "html",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "webm", "mp3", "wav", "zip",
] as const;
/** Directories that never hold deliverables: dependency and build trees,
 *  caches, the plane's own state and the staged user uploads. */
const PRUNED_DIRECTORIES = [
  "node_modules", ".git", ".cache", ".venv", "venv", "__pycache__", "dist", "build", ".next",
  ".claude", ".codex", ".opencode", ".pi", ".config", "coverage",
  ".useagent", ".skynet", ".skynet-inputs", ".useagent-inputs",
] as const;
/** Clock skew allowance between the plane and the sandbox, in seconds. */
const CLOCK_SLACK_SECONDS = 120;
/** Publications per turn. */
export const MAX_HARVESTED_FILES = 20;
/** Records a listing may carry before the sandbox stops printing. */
const MAX_LISTING_RECORDS = 3000;
/** Candidates examined per turn: every listed record, since an unchanged file costs one lookup. */
export const MAX_EXAMINED_FILES = MAX_LISTING_RECORDS;
const LISTING_TIMEOUT_SECONDS = 30;
const STEP_TIMEOUT_MS = 30_000;
/** A publish downloads the file again inside the trusted path; bound that read. */
const DOWNLOAD_TIMEOUT_MS = 60_000;
const HARVEST_BUDGET_MS = 90_000;

export interface HarvestCandidate {
  readonly path: string;
  readonly size: number;
  /** Seconds since the epoch, from the file's mtime. */
  readonly modifiedAt: number;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** One traversal: dependency and state directories are pruned by name from
 *  depth one, any directory below the root holding a `.git` entry (directory
 *  or worktree file) is pruned as a repository, and the deliverable files
 *  changed since the turn started print as `size TAB mtime TAB path`
 *  NUL-terminated records, so any file name survives intact. */
export function fileListCommand(workspaceRoot: string, sinceEpochSeconds: number): string {
  const root = shellQuote(workspaceRoot);
  const prune = PRUNED_DIRECTORIES.map((name) => `-name ${shellQuote(name)}`).join(" -o ");
  const names = DELIVERABLE_EXTENSIONS.map((ext) => `-iname ${shellQuote(`*.${ext}`)}`).join(" -o ");
  return (
    `find ${root} -xdev \\( ${prune} \\) -prune ` +
    `-o \\( ! -path ${root} -type d -exec test -e '{}/.git' \\; \\) -prune ` +
    `-o -type f -newermt ${shellQuote(`@${sinceEpochSeconds}`)} -size -${MAX_ARTIFACT_BYTES + 1}c ` +
    `\\( ${names} \\) -printf '%s\\t%T@\\t%p\\0' 2>/dev/null | head -z -n ${MAX_LISTING_RECORDS}`
  );
}

/** Candidates from the listing, newest first (then by path, so a rerun is
 *  stable): the files this turn just wrote are examined before older ones
 *  the thread may already hold. */
export function parseFileListing(output: string, workspaceRoot: string): HarvestCandidate[] {
  const candidates: HarvestCandidate[] = [];
  for (const record of output.split("\0")) {
    const [digits, stamp, ...rest] = record.split("\t");
    if (digits === undefined || stamp === undefined || rest.length === 0) continue;
    const size = Number(digits);
    const modifiedAt = Number(stamp);
    const path = rest.join("\t");
    if (!/^\d+$/.test(digits) || !Number.isSafeInteger(size) || size <= 0) continue;
    if (!/^\d+(?:\.\d+)?$/.test(stamp) || !Number.isFinite(modifiedAt)) continue;
    if (!path.startsWith(`${workspaceRoot}/`) || path.includes("\n")) continue;
    candidates.push({ path, size, modifiedAt });
  }
  return candidates
    .toSorted((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path))
    .slice(0, MAX_EXAMINED_FILES);
}

type RunRow = NonNullable<Awaited<ReturnType<typeof getRun>>>;

/** What the thread already holds for a path: enough to tell "unchanged" from "revised". */
export interface KnownArtifact {
  readonly id: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  /** When the plane stored it; a file not modified since then is unchanged. */
  readonly createdAt: Date;
}

export interface HarvestDependencies {
  /** Runs the listing command in the run's sandbox and returns its stdout. */
  readonly list: (run: RunRow, command: string) => Promise<string>;
  /** The most recently published artifact of the thread from this workspace path. */
  readonly known: (run: RunRow, path: string) => Promise<KnownArtifact | null>;
  /** The file's current sha256, read from the sandbox. */
  readonly digest: (run: RunRow, path: string) => Promise<string>;
  readonly publish: typeof publishSandboxArtifact;
}

async function sandboxList(run: RunRow, command: string): Promise<string> {
  const sandbox = await resolveRunSandbox(run);
  const result = await sandbox.process.executeCommand(command, undefined, undefined, LISTING_TIMEOUT_SECONDS);
  return result.result ?? "";
}

async function knownThreadArtifact(run: RunRow, path: string): Promise<KnownArtifact | null> {
  if (!run.orgId) return null;
  const [row] = await db
    .select({ id: artifacts.id, sha256: artifacts.sha256, sizeBytes: artifacts.sizeBytes, createdAt: artifacts.createdAt })
    .from(artifacts)
    .where(and(eq(artifacts.orgId, run.orgId), eq(artifacts.threadId, run.threadId), eq(artifacts.sourcePath, path)))
    .orderBy(desc(artifacts.createdAt), desc(artifacts.workpieceRevision))
    .limit(1);
  return row ?? null;
}

async function sandboxDigest(run: RunRow, path: string): Promise<string> {
  if (!run.sandboxId) throw new Error("no sandbox is attached to this run");
  const file = await downloadSandboxFile(run.sandboxId, path, MAX_ARTIFACT_BYTES, run);
  return createHash("sha256").update(file.bytes).digest("hex");
}

const defaultDependencies: HarvestDependencies = {
  list: sandboxList,
  known: knownThreadArtifact,
  digest: sandboxDigest,
  publish: publishSandboxArtifact,
};

class HarvestStopped extends Error {}

/** Start read-only `work` unless the run is already cancelled, then wait at
 *  most `ms` for it. A late result or failure of work we stopped waiting for
 *  is dropped; that is safe only for reads (listing, lookups, digests), which
 *  is why publishing never goes through here: a publish that has started is
 *  awaited to completion, so nothing can persist after the harvest returned. */
function bounded<T>(work: () => Promise<T>, ms: number, signal: AbortSignal | undefined, what: string): Promise<T> {
  if (signal?.aborted) return Promise.reject(new HarvestStopped("run cancelled"));
  if (ms <= 0) return Promise.reject(new HarvestStopped(`${what} has no time left`));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => finish(() => reject(new HarvestStopped("run cancelled")));
    const timer = setTimeout(() => finish(() => reject(new HarvestStopped(`${what} exceeded ${ms} ms`))), ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
    work().then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function kindMismatch(error: unknown): boolean {
  return error instanceof Error && /kind does not match|artifact to update was not found/.test(error.message);
}

/**
 * Publish the deliverables a turn left in its workspace. Never throws: a
 * harvest failure must not fail a run that already finished its work. Reads
 * are bounded by a per-step timeout and the run's abort signal, new work
 * stops once the budget or the run is gone, and a publish that started is
 * finished before this returns, so finalization never overtakes a persist.
 * Returns the artifact ids published or revised.
 */
export async function harvestTurnOutputs(
  runId: string,
  options: { readonly signal?: AbortSignal } = {},
  dependencies: HarvestDependencies = defaultDependencies,
): Promise<string[]> {
  const startedAt = Date.now();
  const left = () => Math.min(STEP_TIMEOUT_MS, HARVEST_BUDGET_MS - (Date.now() - startedAt));
  const published: string[] = [];
  const { signal } = options;
  try {
    if (signal?.aborted) return published;
    const run = await bounded(() => getRun(runId), left(), signal, "run lookup");
    if (!run?.orgId || !run.sandboxId) return published;
    const workspaceRoot = await bounded(
      () => resolveAttachedSandboxWorkspaceRoot({ sandboxId: run.sandboxId!, sandboxProvider: run.sandboxProvider }),
      left(),
      signal,
      "workspace lookup",
    );
    const since = Math.floor(new Date(run.createdAt).getTime() / 1000) - CLOCK_SLACK_SECONDS;
    const candidates = parseFileListing(
      await bounded(() => dependencies.list(run, fileListCommand(workspaceRoot, since)), left(), signal, "listing"),
      workspaceRoot,
    );
    for (const candidate of candidates) {
      // New work starts only while time, the run and the publication cap
      // remain; work already started below is always finished.
      if (left() <= 0 || signal?.aborted || published.length >= MAX_HARVESTED_FILES) break;
      try {
        const known = await bounded(() => dependencies.known(run, candidate.path), left(), signal, "artifact lookup");
        if (known && known.sizeBytes === candidate.size) {
          // Not modified since the plane stored it (with clock allowance): unchanged, no read needed.
          if (known.createdAt.getTime() / 1000 - CLOCK_SLACK_SECONDS >= candidate.modifiedAt) continue;
          const digest = await bounded(() => dependencies.digest(run, candidate.path), left(), signal, "digest");
          if (digest === known.sha256) continue; // unchanged since the thread last published it
        }
        const base = {
          orgId: run.orgId,
          userId: run.userId,
          runId: run.id,
          threadId: run.threadId,
          path: candidate.path,
          purpose: "deliverable" as const,
          downloadTimeoutMs: DOWNLOAD_TIMEOUT_MS,
        };
        // A cancellation that landed during the lookups above stops here,
        // before any publication starts.
        if (signal?.aborted) break;
        // Publishing is awaited to completion, and it settles: each sandbox
        // download is bounded, a storage lock wait times out, and only then
        // does it persist, so finalization never overtakes a persist.
        let result: Awaited<ReturnType<typeof publishSandboxArtifact>>;
        try {
          result = await dependencies.publish(known ? { ...base, updatesArtifactId: known.id } : base);
        } catch (error) {
          // A changed file whose kind cannot revise the existing artifact (an
          // image, an archive, a large office file) is published on its own.
          if (!known || !kindMismatch(error)) throw error;
          if (signal?.aborted) break;
          result = await dependencies.publish(base);
        }
        published.push(result.artifact.id);
      } catch (error) {
        if (error instanceof HarvestStopped) break;
        // Protected paths, secrets and oversize files are refused by the publish
        // path itself; one refusal never stops the rest.
        console.warn(`[artifacts] harvest skipped ${candidate.path}:`, error instanceof Error ? error.message : error);
      }
    }
  } catch (error) {
    console.warn(`[artifacts] harvest ended early for run ${runId}:`, error instanceof Error ? error.message : error);
  }
  return published;
}
