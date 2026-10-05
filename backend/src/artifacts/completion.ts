import { createHash } from "node:crypto";
import { posix } from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, type DbTx } from "../db/client";
import { artifacts, finishedWorkObligations, runs } from "../db/schema";
import { hasRunCancelIntent } from "../commands/cancel";
import { absoluteArtifactPreviewUrl, absoluteArtifactUrl } from "../knowledge/gateway/artifact-links";
import { withFinishedWorkMaterializer } from "../runs/finished-work-materialization-context";
import { lockFinishedWorkRun } from "../runs/finished-work-lock";
import { openFinishedWorkObligation, recordFinishedWorkMaterialization, recordFinishedWorkReceipt, resolveFinishedWorkObligation } from "../runs/finished-work-repo";
import { resolveAttachedSandboxWorkspaceRoot } from "../sandboxes/workspace";
import { discoverTurnOutputs } from "./harvest";
import { publishSandboxArtifact } from "./publish";
import { getArtifactForOrg, type ArtifactDescriptor } from "./repo";
import { explicitOutputLinks, replaceOutputLinks } from "./output-links";

type Run = typeof runs.$inferSelect;
export const ARTIFACT_COMPLETION_FAILURE =
  "Artifact delivery failed: an output could not be published. The task is not complete. Retry the task or inspect its artifact details.";
const OUTPUT_BUDGET_MS = 90_000;
const MAX_OUTPUTS = 20;

export interface ArtifactCompletionOptions {
  readonly signal?: AbortSignal;
  readonly requiresClaim?: boolean;
  /** Non-mutating recovery fence; rechecked in every publication transaction. */
  readonly publicationClaim?: (tx: DbTx) => Promise<boolean>;
}

class LostPublicationClaim extends Error {}

function outputGuard(run: Run, options: ArtifactCompletionOptions, signal: AbortSignal) {
  return async (tx: DbTx): Promise<void> => {
    signal.throwIfAborted();
    await tx.execute(sql`select set_config('lock_timeout', '10000', true), set_config('statement_timeout', '10000', true)`);
    await lockFinishedWorkRun(run.id, tx);
    if (options.requiresClaim && (!options.publicationClaim || !await options.publicationClaim(tx))) {
      throw new LostPublicationClaim();
    }
    const [current] = await tx.select().from(runs)
      .where(and(eq(runs.id, run.id), eq(runs.orgId, run.orgId!))).for("update").limit(1);
    if (!current || !["queued", "running"].includes(current.status)
      || current.threadId !== run.threadId || current.sandboxId !== run.sandboxId
      || current.sandboxProvider !== run.sandboxProvider
      || JSON.stringify(current.expectedSandbox) !== JSON.stringify(run.expectedSandbox)) {
      throw new LostPublicationClaim();
    }
    if (await hasRunCancelIntent(run.orgId!, run.id, tx)) {
      throw new DOMException("Run stopped", "AbortError");
    }
    signal.throwIfAborted();
  };
}

function fileLinks(files: readonly ArtifactDescriptor[]): string {
  if (files.length === 0) return "";
  return "\n\nFiles:\n" + files.map((file) =>
    `- [${file.name.replace(/[\\[\]]/g, "\\$&")}](${absoluteArtifactPreviewUrl(file)})`
  ).join("\n");
}

/** Discovery and sandbox reads occur outside the finalization transaction.
 * Every publication rechecks ownership/cancel in its own short commit; the
 * materializer writes its receipt atomically with the artifact reference. */
export async function completeRunOutputs(
  run: Run,
  summary: string,
  options: ArtifactCompletionOptions = {},
): Promise<{ status: "completed" | "failed" | "obsolete"; summary: string; artifactIds: string[] }> {
  if (!run.orgId || !run.sandboxId) return { status: "completed", summary, artifactIds: [] };
  const signal = AbortSignal.any([
    AbortSignal.timeout(OUTPUT_BUDGET_MS),
    ...(options.signal ? [options.signal] : []),
  ]);
  const guard = outputGuard(run, options, signal);
  const delivered: ArtifactDescriptor[] = [];
  try {
    await db.transaction(guard);
    // A legacy text-only recovery needs no sandbox credentials. Resolve the
    // attached root only when rendered local links actually need publication.
    let links = explicitOutputLinks(summary, "/");
    if (links.length > 0) {
      const root = await resolveAttachedSandboxWorkspaceRoot(run as Run & { sandboxId: string });
      links = explicitOutputLinks(summary, root);
    }
    const explicitPaths = new Set(links.map((link) => link.path));
    const discovered = await discoverTurnOutputs(run, { signal });
    const paths = [...new Set([...explicitPaths, ...discovered.map((file) => file.path)])];
    if (paths.length > MAX_OUTPUTS) throw new Error("too many outputs");
    const urls = new Map<string, { preview: string; download: string }>();
    for (const path of paths) {
      signal.throwIfAborted();
      const [known] = await db.select().from(artifacts).where(and(
        eq(artifacts.orgId, run.orgId), eq(artifacts.threadId, run.threadId), eq(artifacts.sourcePath, path),
      )).orderBy(desc(artifacts.createdAt), desc(artifacts.workpieceRevision)).limit(1);
      const sourceKey = `turn-output:${createHash("sha256").update(run.id).update("\0").update(path).digest("hex")}`;
      const { row: obligation } = await db.transaction(async (tx) => {
        await guard(tx);
        const [prior] = await tx.select().from(finishedWorkObligations).where(and(
          eq(finishedWorkObligations.runId, run.id), eq(finishedWorkObligations.sourceKey, sourceKey),
        )).limit(1);
        const targetArtifactId = prior ? prior.targetArtifactId : known?.id;
        return openFinishedWorkObligation({
          orgId: run.orgId!, runId: run.id, sourceKind: "sandbox_output",
          authority: "integration_gateway", sourceKey, sourceProvider: run.engine,
          requirement: targetArtifactId ? "artifact_update" : "artifact_create",
          ...(targetArtifactId ? { targetArtifactId } : {}),
          candidateName: posix.basename(path).replace(/[\u0000-\u001f\u007f]/g, "_").slice(0, 180),
        }, tx);
      });
      try {
        const published = await withFinishedWorkMaterializer(async (materialized, tx) => {
          const record = await getArtifactForOrg(run.orgId!, materialized.id, tx);
          if (!record) throw new Error("published artifact missing");
          await recordFinishedWorkMaterialization({
            orgId: run.orgId!, runId: run.id, obligationId: obligation.id,
            artifactId: record.id, artifactRevision: record.workpieceRevision,
          }, tx);
          await recordFinishedWorkReceipt({
            orgId: run.orgId!, runId: run.id, obligationId: obligation.id, sourceKey,
            kind: obligation.requirement === "artifact_update" ? "artifact_updated" : "artifact_created", authority: "artifact_store",
            artifactId: record.id, artifactRevision: record.workpieceRevision,
            metadata: { digest: record.sha256, mime: record.contentType.split(";", 1)[0]!, byteCount: record.sizeBytes },
          }, tx);
        }, () => publishSandboxArtifact({
          orgId: run.orgId!, userId: run.userId, runId: run.id, threadId: run.threadId,
          path, purpose: "deliverable", ...(obligation.targetArtifactId ? { updatesArtifactId: obligation.targetArtifactId } : {}),
        }, { signal, beforeCommit: guard, skipUnchangedRevision: true }));
        signal.throwIfAborted();
        urls.set(path, {
          preview: absoluteArtifactUrl(published.artifact.preview_url),
          download: absoluteArtifactUrl(published.artifact.download_url),
        });
        if (explicitPaths.has(path) || !known || known.sha256 !== published.record.sha256) {
          delivered.push(published.artifact);
        }
      } catch (error) {
        if (error instanceof LostPublicationClaim) throw error;
        if (!signal.aborted) await db.transaction(async (tx) => {
          await guard(tx);
          await resolveFinishedWorkObligation({
            orgId: run.orgId!, runId: run.id, obligationId: obligation.id,
            state: "failed", failureCode: "output_publication_failed",
          }, tx);
        });
        throw error;
      }
    }
    const automatic = delivered.filter((file) => !explicitPaths.has(file.source_path));
    return {
      status: "completed", summary: replaceOutputLinks(summary, links, urls) + fileLinks(automatic),
      artifactIds: [...new Set(delivered.map((file) => file.id))],
    };
  } catch (error) {
    return {
      status: error instanceof LostPublicationClaim ? "obsolete" : "failed",
      summary: ARTIFACT_COMPLETION_FAILURE + fileLinks(delivered),
      artifactIds: [...new Set(delivered.map((file) => file.id))],
    };
  }
}
