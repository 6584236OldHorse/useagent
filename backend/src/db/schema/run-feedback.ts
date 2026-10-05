import { sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { runs } from "./runs";

export const RUN_FEEDBACK_VERDICTS = ["good", "bad"] as const;
export type RunFeedbackVerdict = (typeof RUN_FEEDBACK_VERDICTS)[number];

// In-app feedback on a run: one row per (run, user). A resend updates the row
// and bumps its revision. The row is the source of truth; the Slack notice is
// a copy delivered through the outbox (runs/feedback-routes.ts).
export const runFeedback = pgTable(
  "run_feedback",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    verdict: text("verdict").$type<RunFeedbackVerdict>().notNull(),
    text: text("text").notNull().default(""),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("uq_run_feedback_run_user").on(t.runId, t.userId),
    check("chk_run_feedback_verdict", sql`${t.verdict} in ('good', 'bad')`),
  ],
);
