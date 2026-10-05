import type { Hono } from "hono";
import { findCommandByKey } from "../commands/repo";
import type { AppEnv } from "../http";
import { UPLOAD_TTL_MS } from "../uploads/ingest";
import { copyRunUploadsForUser, listRunUploads } from "../uploads/repo";
import { getCustomerRunForOrg, getLatestThreadRun } from "./repo";
import type { RunCreateBody } from "./run-create-policy";
import { handleRunCreate } from "./routes";

/** POST /:id/resend - send the thread's newest run, when it failed, again as a
 * new follow-up, with the same engine, model, reasoning level, memory scope,
 * permission mode, skill and attachments. An older failed turn is refused: the
 * thread has moved on, and its settings (its permission mode above all) must not
 * come back over newer turns. It goes through the ordinary run-create
 * path, so admission, spend and queueing apply as for any reply. The caller's
 * Idempotency-Key (required) makes each click create at most one run; the
 * attachments are copied under ids derived from that key, so a retried request
 * replays instead of conflicting. Native commands are not resent: they need the
 * live command catalog, so the person runs them again from the composer. */
export function registerRunResendRoute(routes: Hono<AppEnv>): void {
  routes.post("/:id/resend", async (c) => {
    const orgId = c.get("orgId");
    const run = await getCustomerRunForOrg(orgId, c.req.param("id"));
    if (!run) return c.json({ error: "run not found" }, 404);
    if (run.status !== "failed") return c.json({ error: "run_not_failed", status: run.status }, 409);
    if (run.commandName) {
      return c.json({ error: "not_resendable", reason: "Commands can't be resent. Run the command again from the composer." }, 409);
    }
    const idempotencyKey = c.req.header("Idempotency-Key")?.trim();
    if (!idempotencyKey) return c.json({ error: "idempotency_key_required" }, 400);
    // A retried click replays the run it created, which is now newer than the
    // failed one; only a first attempt must target the thread's newest run.
    const earlier = await findCommandByKey(orgId, idempotencyKey);
    const replay = earlier?.runId != null && earlier.threadId === run.threadId;
    if (!replay && (await getLatestThreadRun(orgId, run.threadId))?.id !== run.id) {
      return c.json({ error: "run_not_latest", reason: "Only the newest turn can be resent." }, 409);
    }

    // Uploads belong to a person, so a resend without one cannot carry the files.
    const userId = c.get("userId");
    if (!userId && (await listRunUploads(run.id)).length > 0) {
      return c.json({ error: "authenticated user required for attachments" }, 401);
    }
    const attachments = userId
      ? await copyRunUploadsForUser({
          runId: run.id,
          orgId,
          userId,
          seed: `resend:${orgId}:${userId}:${idempotencyKey}`,
          expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
        })
      : [];
    const body: RunCreateBody = {
      prompt: run.prompt,
      engine: run.engine,
      model: run.model,
      reasoning_effort: run.reasoningEffort,
      parent_run_id: run.id,
      memory_scope: run.memoryScope,
      permission_mode: run.permissionMode,
      ...(run.skillId ? { skill: { id: run.skillId, version: run.skillVersion } } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
    return handleRunCreate(c, { body });
  });
}
