import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { runtimeArtifactVerifications } from "../db/schema";

/** Whether the sandbox's native runtime files passed the artifact probe at this generation. */
export async function runtimeArtifactVerified(sandboxId: string, generation: string): Promise<boolean> {
  const rows = await db
    .select({ sandboxId: runtimeArtifactVerifications.sandboxId })
    .from(runtimeArtifactVerifications)
    .where(and(
      eq(runtimeArtifactVerifications.sandboxId, sandboxId),
      eq(runtimeArtifactVerifications.generation, generation),
    ))
    .limit(1);
  return rows.length > 0;
}

export async function recordRuntimeArtifactVerified(sandboxId: string, generation: string): Promise<void> {
  await db.insert(runtimeArtifactVerifications).values({ sandboxId, generation }).onConflictDoNothing();
}
