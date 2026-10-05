import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { providerGatewayAudit } from "../db/schema";
import type { ProviderRequestLimits } from "./limits";
import type { ProviderId } from "./provider";

export type ProviderGatewayAdmissionReason =
  | "request_budget_exhausted"
  | "concurrency_exhausted";

export class ProviderGatewayAdmissionError extends Error {
  constructor(readonly reason: ProviderGatewayAdmissionReason) {
    super(reason);
    this.name = "ProviderGatewayAdmissionError";
  }
}

export interface ProviderGatewayAuditStart {
  readonly id: string;
  readonly runId: string;
  readonly orgId: string;
  readonly provider: ProviderId;
  readonly path: string;
  readonly model: string;
  readonly requestedOutputTokens: number;
}

/** A token count is bookkeeping, not model work, so it never spends the request cap. */
const TOKEN_COUNT_PATH = "/v1/messages/count_tokens";

export async function beginProviderGatewayAudit(
  input: ProviderGatewayAuditStart,
  limits: ProviderRequestLimits,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`provider-gateway:${input.runId}`}))`,
    );
    const counts = await tx.execute(sql`
      select
        count(*) filter (where path <> ${TOKEN_COUNT_PATH})::int as requests,
        count(*) filter (
          where outcome = 'started'
            and created_at > now() - (${limits.upstreamTimeoutMs} * interval '1 millisecond')
        )::int as active
      from provider_gateway_audit
      where run_id = ${input.runId}
    `);
    if (
      input.path !== TOKEN_COUNT_PATH &&
      Number(counts[0]?.requests ?? 0) >= limits.maxRequestsPerRun
    ) {
      throw new ProviderGatewayAdmissionError("request_budget_exhausted");
    }
    if (Number(counts[0]?.active ?? 0) >= limits.maxConcurrentPerRun) {
      throw new ProviderGatewayAdmissionError("concurrency_exhausted");
    }
    await tx.insert(providerGatewayAudit).values({
      ...input,
      outcome: "started",
    });
  });
}

/** The newest upstream call the gateway made for a run, so a settled failure can name its cause. */
export async function latestProviderGatewayOutcome(
  runId: string,
): Promise<{ readonly outcome: string; readonly upstreamStatus: number | null } | null> {
  const [row] = await db
    .select({ outcome: providerGatewayAudit.outcome, upstreamStatus: providerGatewayAudit.upstreamStatus })
    .from(providerGatewayAudit)
    .where(eq(providerGatewayAudit.runId, runId))
    .orderBy(desc(providerGatewayAudit.createdAt))
    .limit(1);
  return row ? { outcome: row.outcome, upstreamStatus: row.upstreamStatus ?? null } : null;
}

export async function finishProviderGatewayAudit(input: {
  readonly id: string;
  readonly outcome: "responded" | "failed";
  readonly upstreamStatus?: number;
  readonly durationMs: number;
}): Promise<void> {
  await db
    .update(providerGatewayAudit)
    .set({
      outcome: input.outcome,
      upstreamStatus: input.upstreamStatus ?? null,
      durationMs: input.durationMs,
      completedAt: new Date(),
    })
    .where(eq(providerGatewayAudit.id, input.id));
}
