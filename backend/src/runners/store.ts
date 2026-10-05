// Durable side of runners: enrolment, the token hash a link authenticates
// with, and the status the API lists. The live link lives in ./registry.ts.

import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { HelloFrame, RunnerCapacity } from "@useagent/runner-protocol";
import { db } from "../db/client";
import { runners } from "../db/schema";

export type RunnerRow = typeof runners.$inferSelect;

export function hashRunnerToken(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex");
}

function base32(bytes: Buffer): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "";
  for (const byte of bytes) out += alphabet[byte % 32];
  return out;
}

/** A fresh runner id and its token `uart_<id>.<secret>`; the token is returned once. */
export function mintRunnerToken(): { runnerId: string; token: string } {
  const runnerId = `rn_${base32(randomBytes(12))}`;
  const secret = base32(randomBytes(30));
  return { runnerId, token: `uart_${runnerId}.${secret}` };
}

export interface EnrolInput {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly platform: string;
}

export async function enrolRunner(input: EnrolInput): Promise<{ runner: RunnerRow; token: string }> {
  const { runnerId, token } = mintRunnerToken();
  const [runner] = await db
    .insert(runners)
    .values({
      id: runnerId,
      orgId: input.orgId,
      userId: input.userId,
      name: input.name,
      platform: input.platform,
      tokenHash: hashRunnerToken(token),
    })
    .returning();
  return { runner: runner!, token };
}

/** The runner a token belongs to, unless it was revoked. */
export async function runnerForToken(token: string): Promise<RunnerRow | null> {
  const [row] = await db.select().from(runners).where(eq(runners.tokenHash, hashRunnerToken(token))).limit(1);
  return row && row.status !== "revoked" ? row : null;
}

export async function listRunners(orgId: string): Promise<RunnerRow[]> {
  return db.select().from(runners).where(eq(runners.orgId, orgId)).orderBy(desc(runners.enrolledAt));
}

export async function getRunner(orgId: string, runnerId: string): Promise<RunnerRow | null> {
  const [row] = await db.select().from(runners).where(and(eq(runners.orgId, orgId), eq(runners.id, runnerId))).limit(1);
  return row ?? null;
}

export async function revokeRunner(orgId: string, runnerId: string): Promise<RunnerRow | null> {
  const [row] = await db
    .update(runners)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(and(eq(runners.orgId, orgId), eq(runners.id, runnerId)))
    .returning();
  return row ?? null;
}

export async function recordHello(runnerId: string, hello: HelloFrame): Promise<void> {
  await db
    .update(runners)
    .set({
      status: "online",
      backend: hello.backend,
      version: hello.version,
      protocol: hello.protocol,
      capacity: hello.capacity,
      logins: [...hello.logins],
      imageDigest: hello.imageDigest,
      lastSeenAt: new Date(),
    })
    .where(eq(runners.id, runnerId));
}

export async function recordHeartbeat(runnerId: string, capacity: RunnerCapacity, logins: readonly string[], imageDigest: string | null): Promise<void> {
  await db
    .update(runners)
    .set({ status: "online", capacity, logins: [...logins], imageDigest, lastSeenAt: new Date() })
    .where(eq(runners.id, runnerId));
}

export async function recordOffline(runnerId: string): Promise<void> {
  await db.update(runners).set({ status: "offline" }).where(and(eq(runners.id, runnerId), eq(runners.status, "online")));
}

/** Rows still marked online from a previous process, or missed heartbeats: offline until they say hello again. */
export async function markStaleRunnersOffline(exceptIds: readonly string[]): Promise<number> {
  const online = await db.select({ id: runners.id }).from(runners).where(eq(runners.status, "online"));
  let count = 0;
  for (const { id } of online) {
    if (exceptIds.includes(id)) continue;
    await recordOffline(id);
    count += 1;
  }
  return count;
}
