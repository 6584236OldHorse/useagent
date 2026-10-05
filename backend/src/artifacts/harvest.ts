/**
 * Turn output harvest: the plane looks at the workspace itself instead of
 * waiting for the agent to call the publish tool. After a sandbox turn, every
 * deliverable file the agent created or changed during the turn (documents,
 * spreadsheets, decks, media, archives) becomes an artifact through the same
 * trusted path the publish tool uses, so the session files rail, the thread's
 * Slack uploads and the artifact hub all see it. Files inside cloned
 * repositories are code changes, not deliverables, and stay out.
 */
import { getRun } from "../runs/repo";
import { resolveRunSandbox } from "../sandboxes/binding";
import { resolveAttachedSandboxWorkspaceRoot } from "../sandboxes/workspace";
import { MAX_ARTIFACT_BYTES, publishSandboxArtifact } from "./publish";

/** File types worth keeping as durable outputs of a turn. */
const DELIVERABLE_EXTENSIONS = [
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "md", "html",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "mp4", "webm", "mp3", "wav", "zip",
] as const;
/** Directories that never hold deliverables and are expensive to walk. */
const PRUNED_DIRECTORIES = [
  "node_modules", ".git", ".cache", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".useagent", ".skynet",
] as const;
/** Clock skew allowance between the plane and the sandbox, in seconds. */
const CLOCK_SLACK_SECONDS = 120;
export const MAX_HARVESTED_FILES = 20;
const HARVEST_BUDGET_MS = 90_000;

export interface HarvestCandidate {
  readonly path: string;
  readonly size: number;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The single shell command that lists candidate files under the workspace. */
export function harvestListCommand(workspaceRoot: string, sinceEpochSeconds: number): string {
  const prune = PRUNED_DIRECTORIES.map((name) => `-name ${shellQuote(name)}`).join(" -o ");
  const names = DELIVERABLE_EXTENSIONS.map((ext) => `-iname ${shellQuote(`*.${ext}`)}`).join(" -o ");
  const root = shellQuote(workspaceRoot);
  return (
    `find ${root} -xdev \\( ${prune} \\) -prune -o -type f -newermt ${shellQuote(`@${sinceEpochSeconds}`)} ` +
    `-size -${Math.floor(MAX_ARTIFACT_BYTES / 1024)}k \\( ${names} \\) -printf '%s\\t%p\\n' 2>/dev/null | head -n 500; ` +
    `printf '\\n--repos--\\n'; find ${root} -xdev -mindepth 2 -maxdepth 5 -type d -name .git -printf '%h\\n' 2>/dev/null`
  );
}

/** Parse the listing: size-tab-path lines, then repository roots after the
 *  marker. Files under a nested repository are dropped; the order is by path
 *  so a rerun is stable. */
export function parseHarvestListing(output: string, workspaceRoot: string): HarvestCandidate[] {
  const [filesPart, reposPart = ""] = output.split("\n--repos--\n");
  const repoRoots = reposPart
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${workspaceRoot}/`));
  const candidates: HarvestCandidate[] = [];
  for (const line of (filesPart ?? "").split("\n")) {
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const size = Number(line.slice(0, tab));
    const path = line.slice(tab + 1);
    if (!Number.isSafeInteger(size) || size <= 0 || !path.startsWith(`${workspaceRoot}/`)) continue;
    if (repoRoots.some((root) => path.startsWith(`${root}/`))) continue;
    candidates.push({ path, size });
  }
  return candidates.toSorted((a, b) => a.path.localeCompare(b.path)).slice(0, MAX_HARVESTED_FILES);
}

export interface HarvestDependencies {
  readonly listing: (run: NonNullable<Awaited<ReturnType<typeof getRun>>>, workspaceRoot: string) => Promise<string>;
  readonly publish: typeof publishSandboxArtifact;
}

async function sandboxListing(
  run: NonNullable<Awaited<ReturnType<typeof getRun>>>,
  workspaceRoot: string,
): Promise<string> {
  const since = Math.floor(new Date(run.createdAt).getTime() / 1000) - CLOCK_SLACK_SECONDS;
  const sandbox = await resolveRunSandbox(run);
  const result = await sandbox.process.executeCommand(harvestListCommand(workspaceRoot, since));
  return result.result ?? "";
}

const defaultDependencies: HarvestDependencies = { listing: sandboxListing, publish: publishSandboxArtifact };

/**
 * Publish the deliverables a turn left in its workspace. Never throws: a
 * harvest failure must not fail a run that already finished its work. Returns
 * the artifact ids it published (or found already published).
 */
export async function harvestTurnOutputs(
  runId: string,
  dependencies: HarvestDependencies = defaultDependencies,
): Promise<string[]> {
  const startedAt = Date.now();
  const published: string[] = [];
  try {
    const run = await getRun(runId);
    if (!run?.orgId || !run.sandboxId) return published;
    const workspaceRoot = await resolveAttachedSandboxWorkspaceRoot({
      sandboxId: run.sandboxId,
      sandboxProvider: run.sandboxProvider,
    });
    const candidates = parseHarvestListing(await dependencies.listing(run, workspaceRoot), workspaceRoot);
    for (const candidate of candidates) {
      if (Date.now() - startedAt > HARVEST_BUDGET_MS) break;
      try {
        const { artifact } = await dependencies.publish({
          orgId: run.orgId,
          userId: run.userId,
          runId: run.id,
          threadId: run.threadId,
          path: candidate.path,
          purpose: "deliverable",
        });
        published.push(artifact.id);
      } catch (error) {
        // Protected paths, secrets and oversize files are refused by the publish
        // path itself; one refusal never stops the rest of the harvest.
        console.warn(`[artifacts] harvest skipped ${candidate.path}:`, error instanceof Error ? error.message : error);
      }
    }
  } catch (error) {
    console.warn(`[artifacts] harvest failed for run ${runId}:`, error instanceof Error ? error.message : error);
  }
  return published;
}
