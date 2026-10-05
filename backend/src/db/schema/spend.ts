import { integer, numeric, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Spend ledger. Every organisation member has an allowance of settled model
// cost; a run (or a stateless chat turn) is charged once when it settles.
// `spend_entries` is the per-charge record (the double-count guard and the
// record of which figure won) and `spend_accounts` the running total the cap
// is checked against.
// ---------------------------------------------------------------------------

/** Where a charge's figure came from: `usage` is the cost the turn's own usage
 *  events carried, `provider_generation` the provider's settled per-generation
 *  figure read back after the turn, and `unpriced` means the events carried
 *  no cost figure (tokens, if any, are still recorded). */
export type SpendSource = "usage" | "provider_generation" | "unpriced";

export const spendAccounts = pgTable(
  "spend_accounts",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    /** Per-member allowance in USD; null means the deployment default applies. */
    allowanceUsd: numeric("allowance_usd", { precision: 14, scale: 6, mode: "number" }),
    spentUsd: numeric("spent_usd", { precision: 14, scale: 6, mode: "number" }).notNull().default(0),
    /** Settled charges for this member, priced or not. */
    runs: integer("runs").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const spendEntries = pgTable("spend_entries", {
  /** The run id, or `chat:<id>` for a stateless chat turn. */
  chargeKey: text("charge_key").primaryKey(),
  orgId: text("org_id").notNull(),
  userId: text("user_id").notNull(),
  costUsd: numeric("cost_usd", { precision: 14, scale: 6, mode: "number" }).notNull(),
  tokens: integer("tokens").notNull().default(0),
  source: text("source").$type<SpendSource>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
