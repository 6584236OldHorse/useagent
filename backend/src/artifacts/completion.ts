import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { Executor } from "../db/client";
import { absoluteArtifactUrl } from "../knowledge/gateway/artifact-links";
import { openFinishedWorkObligation, recordFinishedWorkMaterialization, recordFinishedWorkReceipt, resolveFinishedWorkObligation } from "../runs/finished-work-repo";
import type { runs } from "../db/schema";
import { publishSandboxArtifact } from "./publish";
import { explicitOutputLinks, replaceOutputLinks, type OutputLink } from "./output-links";
import { resolveAttachedSandboxWorkspaceRoot } from "../sandboxes/workspace";

type Run = typeof runs.$inferSelect;
export const ARTIFACT_COMPLETION_FAILURE =
  "Artifact delivery failed: a file offered in the answer could not be published. The task is not complete. Retry the task or inspect its artifact details.";
const MAX_LINKED_OUTPUTS = 20;

export async function runOutputLinks(run: Run, summary: string): Promise<OutputLink[]> {
  if (!run.sandboxId || !run.orgId || !summary.includes("](")) return [];
  const root = await resolveAttachedSandboxWorkspaceRoot(run as Run & { sandboxId: string });
  return explicitOutputLinks(summary, root);
}

/** Caller owns the run serialization and (for recovery) the claim transaction.
 * Only final, explicitly linked files cross the existing publication boundary.
 * The outer transaction records obligations/receipts; immutable publication is
 * independently committed and replay-safe if this finalization crashes. */
export async function completeLinkedArtifacts(
  run: Run,
  summary: string,
  links: readonly OutputLink[],
  exec: Executor,
): Promise<{ status: "completed" | "failed"; summary: string }> {
  if (!run.orgId) return { status: "failed", summary: ARTIFACT_COMPLETION_FAILURE };
  const paths = [...new Set(links.map((link) => link.path))];
  if (paths.length > MAX_LINKED_OUTPUTS) return { status: "failed", summary: ARTIFACT_COMPLETION_FAILURE };
  const urls = new Map<string, { preview: string; download: string }>();
  for (const path of paths) {
    const sourceKey = `linked-output:${createHash("sha256").update(run.id).update("\0").update(path).digest("hex")}`;
    const { row: obligation } = await openFinishedWorkObligation({
      orgId: run.orgId,
      runId: run.id,
      sourceKind: "sandbox_output",
      authority: "integration_gateway",
      sourceKey,
      sourceProvider: run.engine,
      requirement: "artifact_create",
      candidateName: posix.basename(path),
    }, exec);
    try {
      const published = await publishSandboxArtifact({
        orgId: run.orgId,
        userId: run.userId,
        runId: run.id,
        threadId: run.threadId,
        path,
        purpose: "deliverable",
      });
      await recordFinishedWorkMaterialization({
        orgId: run.orgId,
        runId: run.id,
        obligationId: obligation.id,
        artifactId: published.record.id,
        artifactRevision: published.record.workpieceRevision,
      }, exec);
      await recordFinishedWorkReceipt({
        orgId: run.orgId,
        runId: run.id,
        obligationId: obligation.id,
        kind: "artifact_created",
        authority: "artifact_store",
        sourceKey,
        artifactId: published.record.id,
        artifactRevision: published.record.workpieceRevision,
        metadata: {
          digest: published.record.sha256,
          mime: published.record.contentType.split(";", 1)[0]!,
          byteCount: published.record.sizeBytes,
        },
      }, exec);
      urls.set(path, {
        preview: absoluteArtifactUrl(published.artifact.preview_url),
        download: absoluteArtifactUrl(published.artifact.download_url),
      });
    } catch {
      await resolveFinishedWorkObligation({
        orgId: run.orgId,
        runId: run.id,
        obligationId: obligation.id,
        state: "failed",
        failureCode: "linked_output_publication_failed",
      }, exec);
      return { status: "failed", summary: ARTIFACT_COMPLETION_FAILURE };
    }
  }
  return { status: "completed", summary: replaceOutputLinks(summary, links, urls) };
}
