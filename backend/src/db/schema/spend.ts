import { integer, numeric, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { runs } from "./runs";

// ---------------------------------------------------------------------------
// Spend ledger. Every organisation member has an allowance of settled model
// cost; a run is charged once when it settles. `spend_entries` is the per-run
// charge (the double-count guard and the record of which figure won) and
// `spend_accounts` the running total the cap is checked against.
// ---------------------------------------------------------------------------

/** Where a run's charge came from: the cost its own usage events carried, or
 *  the provider's settled per-generation figure read back after the turn. */
export type SpendSource = "step_finish" | "provider_generation";

export const spendAccounts = pgTable(
  "spend_accounts",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    /** Per-member allowance in USD; null means the deployment default applies. */
    allowanceUsd: numeric("allowance_usd", { precision: 14, scale: 6, mode: "number" }),
    spentUsd: numeric("spent_usd", { precision: 14, scale: 6, mode: "number" }).notNull().default(0),
    /** Settled runs charged to this member, priced or not. */
    runs: integer("runs").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const spendEntries = pgTable("spend_entries", {
  runId: text("run_id")
    .primaryKey()
    .references(() => runs.id, { onDelete: "cascade" }),
  orgId: text("org_id").notNull(),
  userId: text("user_id").notNull(),
  costUsd: numeric("cost_usd", { precision: 14, scale: 6, mode: "number" }).notNull(),
  source: text("source").$type<SpendSource>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
