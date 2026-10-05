import type { SandboxProviderKind } from "@useagent/sandbox-contract";
import { index, integer, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Sandbox minutes ledger. Every settled run is charged ONCE to its member with
// the seconds its sandbox leases were held (the primary key is the
// double-count guard); a member's total is the sum of their entries, so the
// cap check takes no account-row lock inside a settlement.
// ---------------------------------------------------------------------------

export const sandboxMinutesEntries = pgTable(
  "sandbox_minutes_entries",
  {
    /** The run id. */
    chargeKey: text("charge_key").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    /** Summed lease lifetimes of the run, in whole seconds. */
    seconds: integer("seconds").notNull(),
    /** How many sandbox leases the run held. */
    sandboxes: integer("sandboxes").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_sandbox_minutes_entries_org_user").on(t.orgId, t.userId)],
);

/** A member's preferred sandbox provider for NEW sandboxes; no row means the
 *  deployment default. Retained thread sandboxes stay where they are. */
export const sandboxPreferences = pgTable(
  "sandbox_preferences",
  {
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    provider: text("provider").$type<SandboxProviderKind>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);
