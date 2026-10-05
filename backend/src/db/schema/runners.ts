import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Machines enrolled as sandbox providers. A row is the durable identity behind
 * one runner token; the live link, capacity and logins are mirrored here from
 * the runner's hello and heartbeats so the API can list machines without
 * touching the in-memory registry.
 */
export const runners = pgTable(
  "runners",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    platform: text("platform").notNull(),
    backend: text("backend"),
    version: text("version"),
    protocol: integer("protocol"),
    capacity: jsonb("capacity").$type<{ cpu: number; memoryMb: number; sandboxes: number; maxSandboxes?: number }>().notNull().default(sql`'{}'::jsonb`),
    logins: jsonb("logins").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    imageDigest: text("image_digest"),
    status: text("status").$type<"enrolled" | "online" | "offline" | "revoked">().notNull().default("enrolled"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** SHA-256 of the runner token; the token itself is shown once and never stored. */
    tokenHash: text("token_hash").notNull().unique(),
  },
  (t) => [index("runners_org_user_idx").on(t.orgId, t.userId), index("runners_status_idx").on(t.status)],
);

/** Per-organisation switches for local execution; absent row = both allowed. */
export const runnerPolicies = pgTable("runner_policies", {
  orgId: text("org_id").primaryKey(),
  allowLocalExecution: boolean("allow_local_execution").notNull().default(true),
  allowLocalLogins: boolean("allow_local_logins").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
