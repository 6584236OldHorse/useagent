import type { CanonicalCommand } from "@useagent/agent-harness/canonical";
import { integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

// The command catalog a native session advertises: one row per (thread, engine,
// session), replaced in place with a rising revision whenever the list changes.
// The reply composer's Compact action and typed commands are authorized against
// exactly this row (runs/command-catalog.ts). It is the plane's own read of the
// runtime, written best effort by the runtime adapter (runs/session-command-catalog.ts),
// never a provider event and never part of a run's sequence.
export const sessionCommandCatalogs = pgTable(
  "session_command_catalogs",
  {
    threadId: text("thread_id").notNull(),
    provider: text("provider").notNull(),
    nativeSessionId: text("native_session_id").notNull(),
    revision: integer("revision").notNull().default(1),
    commands: jsonb("commands").$type<readonly CanonicalCommand[]>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "session_command_catalogs_pk", columns: [t.threadId, t.provider, t.nativeSessionId] })],
);
