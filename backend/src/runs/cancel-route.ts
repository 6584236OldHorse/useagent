import type { Hono } from "hono";
import type { AppEnv } from "../http";
import { assertNever } from "../util/exhaustive";
import { stopRun } from "./stop";

/** POST /:id/cancel - durable user Stop. Records a `run.cancel` command
 * (idempotent), fails a not-yet-started (queued) run atomically, signals a live
 * actor to abort, pumps the thread so the QUEUED lane continues, and stops the
 * runs still working in threads this one delegated to. Org-scoped (a
 * cross-org/missing id is a 404). A run that already settled is a no-op.
 * `?only=queued` (Remove from the queue) cancels only a run that has not
 * started; one that started meanwhile answers 409 and is left running. */
export function registerRunCancelRoute(routes: Hono<AppEnv>): void {
  routes.post("/:id/cancel", async (c) => {
    const id = c.req.param("id");
    const outcome = await stopRun({
      orgId: c.get("orgId"),
      actorId: c.get("userId"),
      runId: id,
      onlyQueued: c.req.query("only") === "queued",
    });
    switch (outcome.status) {
      case "not_found":
        return c.json({ error: "run not found" }, 404);
      case "started":
        return c.json({ id, status: outcome.runStatus, error: "run already started" }, 409);
      case "settled":
        return c.json({ id, status: outcome.runStatus, note: "already settled" }, 200);
      case "cancelling":
        return c.json({ id, status: "cancelling", children: outcome.children }, outcome.replay ? 200 : 202);
      default:
        return assertNever(outcome);
    }
  });
}
