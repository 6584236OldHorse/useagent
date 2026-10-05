/**
 * In-app feedback on a run. POST /api/runs/:id/feedback stores one verdict
 * (good or bad) and an optional note per run and user; a resend updates that
 * row and bumps its revision. A copy goes to the Slack channel named by
 * FEEDBACK_SLACK_CHANNEL as a plain chat.postMessage through the durable Slack
 * outbox, so it is retried and dead-lettered like every other outbox row. The
 * stored row is the source of truth: a notice that cannot be arranged is
 * logged, never an error for the caller.
 */
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import {
  organization,
  RUN_FEEDBACK_VERDICTS,
  runFeedback,
  type RunFeedbackVerdict,
  user,
} from "../db/schema";
import { env, feedbackSlackConfig } from "../env";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { sessionUrl } from "../slack/card";
import { slackMessageBody, slackPlainLabel } from "../slack/mrkdwn";
import { enqueuePostMessageTx, kickSlackOutbox } from "../slack/outbox";
import { findSlackWorkspace } from "../slack/workspaces";
import { getRunForOrg } from "./repo";

export const FEEDBACK_TEXT_MAX = 2000;
export const FEEDBACK_MAX_PER_WINDOW = 10;
export const FEEDBACK_WINDOW_MS = 10 * 60_000;

// ponytail: process-local per-user window. The supported deployment is one
// backend per database, so this is the whole picture; move it to a table if
// replicas ever exist.
const recent = new Map<string, number[]>();

/** Admit one submission for `userId`, or say when the window frees up. */
export function admitFeedback(
  userId: string,
  now = Date.now(),
): { ok: true } | { ok: false; retryAfterMs: number } {
  const stamps = (recent.get(userId) ?? []).filter((at) => at > now - FEEDBACK_WINDOW_MS);
  if (stamps.length >= FEEDBACK_MAX_PER_WINDOW) {
    recent.set(userId, stamps);
    return { ok: false, retryAfterMs: stamps[0]! + FEEDBACK_WINDOW_MS - now };
  }
  stamps.push(now);
  recent.set(userId, stamps);
  return { ok: true };
}

const isVerdict = (value: unknown): value is RunFeedbackVerdict =>
  typeof value === "string" && (RUN_FEEDBACK_VERDICTS as readonly string[]).includes(value);

/** The Slack notice: the verdict, who sent it from which organisation, the run
 *  link, then the note quoted. Names are server chrome; the note is user text. */
export function feedbackSlackText(input: {
  verdict: RunFeedbackVerdict;
  text: string;
  revision: number;
  runId: string;
  runUrl: string;
  orgName: string;
  userName: string;
  userEmail: string | null;
}): string {
  const head =
    `${input.verdict === "good" ? ":+1: Good" : ":-1: Bad"} run feedback` +
    `${input.revision > 1 ? " (updated)" : ""} from ${slackPlainLabel(input.userName)}` +
    `${input.userEmail ? ` (${slackPlainLabel(input.userEmail)})` : ""}` +
    ` at ${slackPlainLabel(input.orgName)}: <${input.runUrl}|run ${input.runId}>`;
  const note = input.text.trim();
  if (!note) return head;
  const quoted = slackMessageBody(note)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${head}\n${quoted}`;
}

/** Where the notice goes, or null with the reason logged (the row still stands). */
async function feedbackDestination(): Promise<{ channel: string; teamId: string; orgId: string } | null> {
  const config = feedbackSlackConfig();
  if (!config) {
    if (process.env.FEEDBACK_SLACK_CHANNEL?.trim()) {
      console.warn(
        "[run-feedback] FEEDBACK_SLACK_CHANNEL is set but the Slack adapter or the workspace id (FEEDBACK_SLACK_TEAM_ID or SLACK_LEGACY_TEAM_ID) is missing; feedback is stored without a Slack notice",
      );
    }
    return null;
  }
  const workspace = await findSlackWorkspace(config.teamId);
  if (!workspace) {
    console.warn(
      `[run-feedback] Slack workspace ${config.teamId} has no slack_workspaces row; feedback is stored without a Slack notice`,
    );
    return null;
  }
  return { ...config, orgId: workspace.orgId };
}

async function storeFeedback(input: {
  run: { id: string; threadId: string };
  orgId: string;
  userId: string;
  verdict: RunFeedbackVerdict;
  text: string;
}) {
  const destination = await feedbackDestination();
  const row = await db.transaction(async (tx) => {
    const [saved] = await tx
      .insert(runFeedback)
      .values({
        id: crypto.randomUUID(),
        runId: input.run.id,
        orgId: input.orgId,
        userId: input.userId,
        verdict: input.verdict,
        text: input.text,
      })
      .onConflictDoUpdate({
        target: [runFeedback.runId, runFeedback.userId],
        set: {
          verdict: input.verdict,
          text: input.text,
          revision: sql`${runFeedback.revision} + 1`,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (destination) {
      const [org] = await tx
        .select({ name: organization.name })
        .from(organization)
        .where(eq(organization.id, input.orgId))
        .limit(1);
      const [who] = await tx
        .select({ name: user.name, email: user.email })
        .from(user)
        .where(eq(user.id, input.userId))
        .limit(1);
      // The row's org is the workspace's own: the outbox posts with that
      // workspace's bot, whichever organisation the feedback came from.
      await enqueuePostMessageTx(tx, {
        idempotencyKey: `run-feedback:${saved!.id}:${saved!.revision}`,
        orgId: destination.orgId,
        teamId: destination.teamId,
        channel: destination.channel,
        text: feedbackSlackText({
          verdict: saved!.verdict,
          text: saved!.text,
          revision: saved!.revision,
          runId: input.run.id,
          runUrl: sessionUrl(env.FRONTEND_ORIGIN, input.run.threadId),
          orgName: org?.name ?? input.orgId,
          userName: who?.name ?? input.userId,
          userEmail: who?.email ?? null,
        }),
      });
    }
    return saved!;
  });
  if (destination) kickSlackOutbox();
  return row;
}

export const runFeedbackRoutes = new Hono<AppEnv>();
runFeedbackRoutes.use("*", orgScope);

runFeedbackRoutes.post("/:id/feedback", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "user_required" }, 403);
  const body = (await c.req.json().catch(() => null)) as { verdict?: unknown; text?: unknown } | null;
  const verdict = body?.verdict;
  if (!isVerdict(verdict)) return c.json({ error: "verdict must be good or bad" }, 400);
  const text = body?.text ?? "";
  if (typeof text !== "string" || text.length > FEEDBACK_TEXT_MAX) {
    return c.json({ error: `text must be a string of at most ${FEEDBACK_TEXT_MAX} characters` }, 400);
  }
  const run = await getRunForOrg(c.get("orgId"), c.req.param("id"));
  if (!run) return c.json({ error: "not_found" }, 404);
  const admitted = admitFeedback(userId);
  if (!admitted.ok) {
    return c.json({ error: "rate_limited", retry_after_ms: admitted.retryAfterMs }, 429);
  }
  const row = await storeFeedback({ run, orgId: c.get("orgId"), userId, verdict, text: text.trim() });
  return c.json({
    id: row.id,
    run_id: row.runId,
    verdict: row.verdict,
    text: row.text,
    revision: row.revision,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  });
});
