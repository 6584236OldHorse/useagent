/**
 * Turn output harvest: the plane looks at the workspace itself instead of
 * waiting for the agent to call the publish tool. After a sandbox turn, every
 * deliverable file the agent created or changed during the turn (documents,
 * spreadsheets, decks, media, archives) becomes an artifact through the same
 * trusted path the publish tool uses, so the session files rail, the thread's
 * Slack uploads and the artifact hub all see it. Files inside cloned
 * repositories are code changes, not deliverables, and stay out; a file the
 * thread already holds with the same bytes is skipped, and a changed file
 * becomes a new revision of the thread's artifact rather than a duplicate.
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
  ".useagent", ".skynet", ".skynet-inputs", ".useagent-inputs",
] as const;
/** Clock skew allowance between the plane and the sandbox, in seconds. */
const CLOCK_SLACK_SECONDS = 120;
export const MAX_HARVESTED_FILES = 20;
/** Records a listing may carry before the sandbox stops printing. */
const MAX_LISTING_RECORDS = 3000;
/** Nested repositories the file pass prunes; more than this and the rest are filtered after listing. */
const MAX_PRUNED_REPOSITORIES = 64;
const LISTING_TIMEOUT_SECONDS = 30;
const PUBLISH_TIMEOUT_MS = 30_000;
const HARVEST_BUDGET_MS = 90_000;

export interface HarvestCandidate {
  readonly path: string;
  readonly size: number;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const pruneClause = (names: readonly string[]) => names.map((name) => `-name ${shellQuote(name)}`).join(" -o ");

/** Pass one: every nested repository root (a `.git` directory or worktree
 *  file) below the workspace, one NUL-terminated path each. The workspace
 *  root itself is not a nested repository even when it is one. */
export function repositoryListCommand(workspaceRoot: string): string {
  const root = shellQuote(workspaceRoot);
  return (
    `find ${root} -xdev -mindepth 2 \\( ${pruneClause(PRUNED_DIRECTORIES.filter((n) => n !== ".git"))} \\) -prune ` +
    `-o -name .git -printf '%h\\0' -prune 2>/dev/null | head -z -n ${MAX_LISTING_RECORDS}`
  );
}

/** Pass two: deliverable files changed since the turn started, outside the
 *  pruned directories and the repositories pass one found; one record per
 *  file, `size TAB path`, NUL-terminated so any file name survives intact. */
export function fileListCommand(
  workspaceRoot: string,
  sinceEpochSeconds: number,
  repositoryRoots: readonly string[],
): string {
  const root = shellQuote(workspaceRoot);
  const repos = repositoryRoots.slice(0, MAX_PRUNED_REPOSITORIES).map((r) => `-path ${shellQuote(r)}`);
  const prune = [pruneClause(PRUNED_DIRECTORIES), ...repos].join(" -o ");
  const names = DELIVERABLE_EXTENSIONS.map((ext) => `-iname ${shellQuote(`*.${ext}`)}`).join(" -o ");
  return (
    `find ${root} -xdev \\( ${prune} \\) -prune -o -type f -newermt ${shellQuote(`@${sinceEpochSeconds}`)} ` +
    `-size -${MAX_ARTIFACT_BYTES + 1}c \\( ${names} \\) -printf '%s\\t%p\\0' 2>/dev/null | head -z -n ${MAX_LISTING_RECORDS}`
  );
}

/** Repository roots from pass one: absolute paths strictly below the workspace. */
export function parseRepositoryListing(output: string, workspaceRoot: string): string[] {
  return output
    .split("\0")
    .filter((path) => path.startsWith(`${workspaceRoot}/`))
    .toSorted();
}

/** Candidates from pass two. Repositories are filtered again here (pass two
 *  prunes at most MAX_PRUNED_REPOSITORIES of them), then sorted by path so a
 *  rerun is stable, then capped. */
export function parseFileListing(
  output: string,
  workspaceRoot: string,
  repositoryRoots: readonly string[],
): HarvestCandidate[] {
  const candidates: HarvestCandidate[] = [];
  for (const record of output.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab <= 0) continue;
    const size = Number(record.slice(0, tab));
    const path = record.slice(tab + 1);
    if (!/^\d+$/.test(record.slice(0, tab)) || !Number.isSafeInteger(size) || size <= 0) continue;
    if (!path.startsWith(`${workspaceRoot}/`) || path.includes("\n")) continue;
    if (repositoryRoots.some((root) => path === root || path.startsWith(`${root}/`))) continue;
    candidates.push({ path, size });
  }
  return candidates.toSorted((a, b) => a.path.localeCompare(b.path)).slice(0, MAX_HARVESTED_FILES);
}

type RunRow = NonNullable<Awaited<ReturnType<typeof getRun>>>;

/** What the thread already holds for a path: enough to tell "unchanged" from "revised". */
export interface KnownArtifact {
  readonly id: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface HarvestDependencies {
  /** Runs one listing command in the run's sandbox and returns its stdout. */
  readonly list: (run: RunRow, command: string) => Promise<string>;
  /** The newest artifact of the thread published from this workspace path. */
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
    .select({ id: artifacts.id, sha256: artifacts.sha256, sizeBytes: artifacts.sizeBytes })
    .from(artifacts)
    .where(and(eq(artifacts.orgId, run.orgId), eq(artifacts.threadId, run.threadId), eq(artifacts.sourcePath, path)))
    .orderBy(desc(artifacts.workpieceRevision), desc(artifacts.createdAt))
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

/** Resolve `work` within `ms`, or throw; an aborted signal throws at once. */
function bounded<T>(work: Promise<T>, ms: number, signal: AbortSignal | undefined, what: string): Promise<T> {
  if (signal?.aborted) return Promise.reject(new HarvestStopped("run cancelled"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HarvestStopped(`${what} exceeded ${ms} ms`)), ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(new HarvestStopped("run cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    });
  });
}

/**
 * Publish the deliverables a turn left in its workspace. Never throws: a
 * harvest failure must not fail a run that already finished its work. Bounded
 * by a total budget, a per-step timeout and the run's abort signal, so
 * finalization is never held. Returns the artifact ids published or revised.
 */
export async function harvestTurnOutputs(
  runId: string,
  options: { readonly signal?: AbortSignal } = {},
  dependencies: HarvestDependencies = defaultDependencies,
): Promise<string[]> {
  const startedAt = Date.now();
  const remaining = () => HARVEST_BUDGET_MS - (Date.now() - startedAt);
  const published: string[] = [];
  const { signal } = options;
  try {
    const run = await getRun(runId);
    if (!run?.orgId || !run.sandboxId) return published;
    const workspaceRoot = await resolveAttachedSandboxWorkspaceRoot({
      sandboxId: run.sandboxId,
      sandboxProvider: run.sandboxProvider,
    });
    const since = Math.floor(new Date(run.createdAt).getTime() / 1000) - CLOCK_SLACK_SECONDS;
    const repositories = parseRepositoryListing(
      await bounded(dependencies.list(run, repositoryListCommand(workspaceRoot)), LISTING_TIMEOUT_SECONDS * 1000, signal, "repository listing"),
      workspaceRoot,
    );
    const candidates = parseFileListing(
      await bounded(dependencies.list(run, fileListCommand(workspaceRoot, since, repositories)), LISTING_TIMEOUT_SECONDS * 1000, signal, "file listing"),
      workspaceRoot,
      repositories,
    );
    for (const candidate of candidates) {
      const budget = Math.min(PUBLISH_TIMEOUT_MS, remaining());
      if (budget <= 0 || signal?.aborted) break;
      try {
        const known = await bounded(dependencies.known(run, candidate.path), budget, signal, "artifact lookup");
        if (known && known.sizeBytes === candidate.size) {
          const digest = await bounded(dependencies.digest(run, candidate.path), budget, signal, "digest");
          if (digest === known.sha256) continue; // unchanged since the thread last published it
        }
        const { artifact } = await bounded(
          dependencies.publish({
            orgId: run.orgId,
            userId: run.userId,
            runId: run.id,
            threadId: run.threadId,
            path: candidate.path,
            purpose: "deliverable",
            ...(known ? { updatesArtifactId: known.id } : {}),
          }),
          budget,
          signal,
          "publish",
        );
        published.push(artifact.id);
      } catch (error) {
        if (error instanceof HarvestStopped) break;
        // Protected paths, secrets, oversize files and kind mismatches are
        // refused by the publish path itself; one refusal never stops the rest.
        console.warn(`[artifacts] harvest skipped ${candidate.path}:`, error instanceof Error ? error.message : error);
      }
    }
  } catch (error) {
    console.warn(`[artifacts] harvest ended early for run ${runId}:`, error instanceof Error ? error.message : error);
  }
  return published;
}
