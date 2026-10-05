import { sql } from "drizzle-orm";
import { index, integer, numeric, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Spend ledger. Every organisation member has an allowance of settled model
// cost; a run (or a stateless chat turn) is charged once when it settles.
// `spend_entries` is the per-charge record (the double-count guard and the
// record of which figure won) and `spend_accounts` the running total the cap
// is checked against.
// ---------------------------------------------------------------------------

/** Where a charge's figure came from: `pending` is a charge opened before its
 *  turn ran whose figure is not filled in yet (a chat turn opens one before
 *  any model call, so a completion that fails to write is never a lost
 *  figure), `usage` the cost the turn's own usage events carried,
 *  `provider_generation` the provider's settled per-generation figure read
 *  back after the turn, and `unpriced` means the events carried no cost
 *  figure (tokens, if any, are still recorded). */
export type SpendSource = "pending" | "usage" | "provider_generation" | "unpriced";
/** A charge's figure once settled: every source but `pending`. */
export type SettledSpendSource = Exclude<SpendSource, "pending">;

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

export const spendEntries = pgTable(
  "spend_entries",
  {
    /** The run id, or `chat:<id>` for a stateless chat turn. */
    chargeKey: text("charge_key").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    costUsd: numeric("cost_usd", { precision: 14, scale: 6, mode: "number" }).notNull(),
    tokens: integer("tokens").notNull().default(0),
    source: text("source").$type<SpendSource>().notNull(),
    /** The provider's generation id for a chat turn, noted as soon as the
     *  stream names it, so a charge left pending can be priced from the
     *  provider's own record. */
    generationId: text("generation_id"),
    /** Set on a pending entry once its figure is known (the stream ended and
     *  was priced) but before the account moved: the source the figure will
     *  settle under, so a settlement the ledger refused can be completed from
     *  the stored figure alone. */
    figureSource: text("figure_source").$type<SettledSpendSource>(),
    /** When the charge was opened. */
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("spend_entries_pending_idx").on(t.createdAt).where(sql`${t.source} = 'pending'`)],
);
