import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

// Sandboxes whose native runtime files passed the artifact probe, per runtime
// generation. The probe is a corruption check run once per sandbox and
// generation; this row lets a restarted backend skip it as the process that
// ran it would (engines/runtime-environment-client.ts). Written only by the backend.
export const runtimeArtifactVerifications = pgTable(
  "runtime_artifact_verifications",
  {
    sandboxId: text("sandbox_id").notNull(),
    generation: text("generation").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "runtime_artifact_verifications_pk", columns: [t.sandboxId, t.generation] })],
);
