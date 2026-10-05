import { and, eq, like, lt, or, sql } from "drizzle-orm";
import { db, type Executor } from "../db/client";
import { providerEvents, spendAccounts, spendEntries, type SpendSource } from "../db/schema";

// ---------------------------------------------------------------------------
// Spend allowance. Every organisation member may spend SPEND_ALLOWANCE_USD
// (default 100) of settled model cost. A run is charged ONCE when it settles,
// from the real cost its usage events carry; a member at or past the allowance
// is refused new runs at acceptance, and a running turn is never cut off.
// SPEND_ALLOWANCE_USD=0 turns the cap off (the ledger keeps accruing).
// ---------------------------------------------------------------------------

/** The most one charge or one account may carry: well inside numeric(14,6), so a
 *  runaway figure is clamped and logged instead of rolling a settlement back. */
export const SPEND_CHARGE_MAX_USD = 1_000_000;

let ceilingWarned = false;

/** The deployment-wide allowance in USD; 0 (or an unusable value) disables the
 *  cap. An allowance above the ledger's ceiling could never be reached, since
 *  an account saturates there, so it is clamped to the ceiling and logged once
 *  (validated at boot by src/index.ts, and on every read). */
export function spendAllowanceDefaultUsd(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SPEND_ALLOWANCE_USD?.trim();
  if (raw === undefined || raw === "") return 100;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  if (parsed > SPEND_CHARGE_MAX_USD) {
    if (!ceilingWarned) {
      ceilingWarned = true;
      console.warn(
        `[spend] SPEND_ALLOWANCE_USD=${raw} is above the ${SPEND_CHARGE_MAX_USD} ceiling an account can reach; using the ceiling`,
      );
    }
    return SPEND_CHARGE_MAX_USD;
  }
  return parsed;
}

/** A member's effective allowance: the override or the default, never above
 *  the ceiling an account can reach. */
const effectiveAllowance = (override: number | null, fallback: number): number =>
  Math.min(override ?? fallback, SPEND_CHARGE_MAX_USD);
/** The token column is a Postgres integer; a count past it is clamped, never a failed settlement. */
export const SPEND_TOKENS_MAX = 2_147_483_647;

const usd = (n: number): string => `$${n.toFixed(2)}`;

export class SpendAllowanceExceededError extends Error {
  readonly code = "spend_allowance_exceeded" as const;

  constructor(readonly spent: number, readonly allowance: number) {
    super(
      `You have spent ${usd(spent)} of your ${usd(allowance)} allowance. ` +
        "New tasks are paused until it is raised.",
    );
    this.name = "SpendAllowanceExceededError";
  }

  /** The refusal every ingress answers with. */
  get body() {
    return { error: this.code, message: this.message, spent: this.spent, allowance: this.allowance };
  }
}

/**
 * Refuse new work for a member at or past the allowance. A plain read of the
 * committed figure, deliberately without a row lock or a first-touch insert:
 * the acceptance transaction already holds thread and admission locks, and a
 * lock taken here would sit in the middle of that order and could close a
 * cycle with a settling run (the ledger row is created by the first charge
 * instead). A charge that commits a moment after this read is seen by the
 * next acceptance, which is all a cap on settled spend can promise. Runs
 * without a person behind them have nothing to charge and pass.
 */
export async function assertSpendAllowance(
  orgId: string,
  userId: string | null,
  exec: Executor = db,
): Promise<void> {
  const fallback = spendAllowanceDefaultUsd();
  if (!userId || fallback <= 0) return;
  const [account] = await exec
    .select({ allowanceUsd: spendAccounts.allowanceUsd, spentUsd: spendAccounts.spentUsd })
    .from(spendAccounts)
    .where(and(eq(spendAccounts.orgId, orgId), eq(spendAccounts.userId, userId)))
    .limit(1);
  const spent = account?.spentUsd ?? 0;
  const allowance = effectiveAllowance(account?.allowanceUsd ?? null, fallback);
  if (spent >= allowance) throw new SpendAllowanceExceededError(spent, allowance);
}

// ── Reading a run's usage ───────────────────────────────────────────────────

/** One priced figure: the cost (USD) and tokens a usage record carried. */
export interface UsageFigure {
  readonly cost: number | null;
  readonly tokens: number;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** A charge figure a run may carry; anything else is logged and clamped, never
 *  subtracted, never allowed to roll the settlement back. */
export function boundedCost(value: number | null, context: string): number | null {
  if (value === null) return null;
  if (value < 0 || value > SPEND_CHARGE_MAX_USD) {
    console.warn(`[spend] ${context}: cost ${value} is outside [0, ${SPEND_CHARGE_MAX_USD}]; clamped`);
    return Math.min(Math.max(value, 0), SPEND_CHARGE_MAX_USD);
  }
  return value;
}

/** Tokens from a usage record in either grammar: the `part.step-finish` shape
 *  (`tokens.total`, or input + output + cache) or the typed usage the runtime
 *  reports on task and tool activities (`totalTokens`, or the summed parts). */
const boundedTokens = (value: number): number =>
  Math.min(SPEND_TOKENS_MAX, Math.max(0, Math.round(value)));

function usageTokens(usage: Record<string, unknown> | null): number {
  if (!usage) return 0;
  const tokens = record(usage.tokens);
  if (tokens) {
    const cache = record(tokens.cache);
    return boundedTokens(
      finite(tokens.total) ??
        (finite(tokens.input) ?? 0) + (finite(tokens.output) ?? 0) +
          (finite(cache?.read) ?? 0) + (finite(cache?.write) ?? 0),
    );
  }
  return boundedTokens(
    finite(usage.totalTokens) ??
      (finite(usage.inputTokens) ?? 0) + (finite(usage.outputTokens) ?? 0) +
        (finite(usage.reasoningOutputTokens) ?? 0) + (finite(usage.cachedInputTokens) ?? 0),
  );
}

/** The figure a stored `part.step-finish` usage event carries. */
function stepFinishFigure(payload: Record<string, unknown>): UsageFigure & { readonly settled: boolean } {
  return {
    cost: finite(payload.cost),
    tokens: usageTokens(payload),
    settled: payload.costSource === "provider_generation",
  };
}

/**
 * The figure a stored runtime activity (`t3.activity.*`) carries. The runtime
 * reports usage on task and tool activities as `typedUsage` (or `usage`) in
 * the activity payload, under exactly the nesting the harness's canonical
 * extractor reads for child usage (payload.state, data.state, data.item.state,
 * data.item, data, then the payload itself), with the cost as `costUsd` or
 * `cost` beside it.
 */
function runtimeActivityFigure(stored: Record<string, unknown>): UsageFigure | null {
  const payload = record(stored.payload);
  if (!payload) return null;
  const data = record(payload.data);
  const item = record(data?.item);
  const containers = [
    record(payload.state), record(data?.state), record(item?.state), item, data, payload,
  ];
  let usage: Record<string, unknown> | null = null;
  for (const container of containers) {
    usage = record(container?.typedUsage) ?? record(container?.usage);
    if (usage) break;
  }
  let cost: number | null = null;
  for (const container of [usage, ...containers]) {
    cost = finite(container?.costUsd) ?? finite(container?.cost);
    if (cost !== null) break;
  }
  if (!usage && cost === null) return null;
  return { cost, tokens: usageTokens(usage) };
}

/** A charge's figure once settled: every source but `pending`. */
export type SettledSpendSource = Exclude<SpendSource, "pending">;

export interface RunCharge {
  readonly cost: number;
  readonly tokens: number;
  readonly source: SettledSpendSource;
}

/**
 * Price a settled run from the usage events it actually carries. Step-finish
 * events (OpenCode's own lane, Pi, chat) are one figure per model call and are
 * summed. Runtime activities report CUMULATIVE usage per task or tool call and
 * are revised under the same identity as they progress, so the largest figure
 * per identity is taken and those are summed. A run whose events carried
 * tokens but no cost is `unpriced`: there is no per-token rate table in the
 * deployment, and a guessed price would be worse than an honest zero with the
 * tokens beside it. Reads the rows into code, not a SQL cast, so a malformed
 * payload can never keep a run from settling.
 */
export async function priceRunUsage(runId: string, exec: Executor = db): Promise<RunCharge> {
  const rows = await exec
    .select({
      id: providerEvents.id, provider: providerEvents.provider, eventType: providerEvents.eventType,
      nativeCallId: providerEvents.nativeCallId, payload: providerEvents.payload,
    })
    .from(providerEvents)
    .where(and(
      eq(providerEvents.runId, runId),
      or(eq(providerEvents.eventType, "part.step-finish"), like(providerEvents.eventType, "t3.activity.%")),
    ));
  let cost = 0;
  let tokens = 0;
  let priced = false;
  let settled = false;
  const perIdentity = new Map<string, UsageFigure>();
  for (const row of rows) {
    let stored: Record<string, unknown> | null = null;
    try {
      stored = row.payload ? record(JSON.parse(row.payload)) : null;
    } catch {
      stored = null;
    }
    if (!stored) continue;
    if (row.eventType === "part.step-finish") {
      // The runtime lane stores the context in use after a call as its own
      // step-finish frame (runtime-usage-frame.ts), revised in place: a
      // snapshot the composer ring reads, not a per-call ledger. That lane is
      // priced from its activities below.
      if (row.provider === "t3") continue;
      const figure = stepFinishFigure(stored);
      const bounded = boundedCost(figure.cost, `run ${runId} event ${row.id}`);
      if (bounded !== null) {
        cost += bounded;
        priced = true;
      }
      tokens += figure.tokens;
      settled ||= figure.settled;
      continue;
    }
    const figure = runtimeActivityFigure(stored);
    if (!figure) continue;
    const bounded = boundedCost(figure.cost, `run ${runId} event ${row.id}`);
    const identity = row.nativeCallId ?? row.id;
    const previous = perIdentity.get(identity);
    perIdentity.set(identity, {
      cost: bounded === null ? (previous?.cost ?? null) : Math.max(previous?.cost ?? 0, bounded),
      tokens: Math.max(previous?.tokens ?? 0, figure.tokens),
    });
  }
  for (const figure of perIdentity.values()) {
    if (figure.cost !== null) {
      cost += figure.cost;
      priced = true;
    }
    tokens += figure.tokens;
  }
  cost = Math.min(cost, SPEND_CHARGE_MAX_USD);
  tokens = boundedTokens(tokens);
  const source: SettledSpendSource = settled ? "provider_generation" : priced ? "usage" : "unpriced";
  if (source === "unpriced" && tokens > 0) {
    console.warn(`[spend] run ${runId} reported ${tokens} tokens but no cost; charged as unpriced`);
  }
  return { cost, tokens, source };
}

// ── Charging ────────────────────────────────────────────────────────────────

/**
 * Record one charge and add it to the member's account, once and together.
 * The per-charge entry is the guard: a second settlement, a replayed finalize
 * or a concurrent charge under the same key inserts nothing and charges
 * nothing; an entry opened as `pending` before its turn ran is filled in
 * here, once. Handed the pool, it runs as one short transaction, so no reader
 * ever sees the entry without its account movement. The account upsert takes
 * the member's row lock, so a caller inside a larger transaction must make
 * this its LAST statement: a transaction that holds that lock must never go
 * on to wait for anything else.
 */
export async function chargeSpend(
  input: {
    readonly key: string;
    readonly orgId: string;
    readonly userId: string;
    readonly cost: number;
    readonly tokens: number;
    readonly source: SettledSpendSource;
    readonly generationId?: string | null;
  },
  exec: Executor = db,
): Promise<boolean> {
  if (exec === db) return db.transaction((tx) => chargeSpend(input, tx));
  const cost = boundedCost(input.cost, `charge ${input.key}`) ?? 0;
  const tokens = Number.isFinite(input.tokens) ? boundedTokens(input.tokens) : 0;
  const settled = await exec
    .insert(spendEntries)
    .values({
      chargeKey: input.key,
      orgId: input.orgId,
      userId: input.userId,
      costUsd: cost,
      tokens,
      source: input.source,
      generationId: input.generationId ?? null,
    })
    .onConflictDoUpdate({
      target: spendEntries.chargeKey,
      set: {
        costUsd: cost,
        tokens,
        source: input.source,
        generationId: sql`coalesce(excluded.generation_id, ${spendEntries.generationId})`,
      },
      setWhere: eq(spendEntries.source, "pending"),
    })
    .returning({ chargeKey: spendEntries.chargeKey });
  if (settled.length === 0) return false; // already charged
  await exec
    .insert(spendAccounts)
    .values({ orgId: input.orgId, userId: input.userId, spentUsd: cost, runs: 1 })
    .onConflictDoUpdate({
      target: [spendAccounts.orgId, spendAccounts.userId],
      set: {
        spentUsd: sql`least(${spendAccounts.spentUsd} + ${cost}::numeric, ${SPEND_CHARGE_MAX_USD}::numeric)`,
        runs: sql`${spendAccounts.runs} + 1`,
        updatedAt: new Date(),
      },
    });
  return true;
}

/**
 * Open a charge before the work it pays for runs, so the intent to charge is
 * durable from the start: a completion that fails to write leaves a pending
 * entry to be settled (chargeSpend fills it in; chat/turn.ts sweeps what the
 * process never completed), never a lost figure. Idempotent under its key.
 */
export async function openSpendCharge(input: {
  readonly key: string;
  readonly orgId: string;
  readonly userId: string;
}): Promise<void> {
  await db
    .insert(spendEntries)
    .values({ chargeKey: input.key, orgId: input.orgId, userId: input.userId, costUsd: 0, tokens: 0, source: "pending" })
    .onConflictDoNothing();
}

/** Drop a charge opened for a turn that never made a model call. */
export async function discardSpendCharge(key: string): Promise<void> {
  await db.delete(spendEntries).where(and(eq(spendEntries.chargeKey, key), eq(spendEntries.source, "pending")));
}

/** Note the provider's generation id on an open charge as soon as the stream
 *  names it, so a charge the process never completes can still be priced from
 *  the provider's record. */
export async function noteSpendGeneration(key: string, generationId: string): Promise<void> {
  await db
    .update(spendEntries)
    .set({ generationId })
    .where(and(eq(spendEntries.chargeKey, key), eq(spendEntries.source, "pending")));
}

/** Charges opened before `openedBefore` and never filled in. */
export async function pendingSpendCharges(openedBefore: Date): Promise<Array<{
  readonly key: string;
  readonly orgId: string;
  readonly userId: string;
  readonly generationId: string | null;
}>> {
  return db
    .select({
      key: spendEntries.chargeKey,
      orgId: spendEntries.orgId,
      userId: spendEntries.userId,
      generationId: spendEntries.generationId,
    })
    .from(spendEntries)
    .where(and(eq(spendEntries.source, "pending"), lt(spendEntries.createdAt, openedBefore)));
}

/** Charge a settled run to its member from the usage it carries. Runs without
 *  an org or a person behind them have nothing to charge. */
export async function accrueRunSpend(
  run: { readonly id: string; readonly orgId: string | null; readonly userId: string | null },
  exec: Executor,
): Promise<void> {
  if (!run.orgId || !run.userId) return;
  const charge = await priceRunUsage(run.id, exec);
  await chargeSpend({ key: run.id, orgId: run.orgId, userId: run.userId, ...charge }, exec);
}

export interface SpendSnapshot {
  readonly spent: number;
  /** Null when the cap is off. */
  readonly allowance: number | null;
  readonly runs: number;
}

/** The member's own figures. */
export async function spendSnapshot(orgId: string, userId: string | null): Promise<SpendSnapshot> {
  const fallback = spendAllowanceDefaultUsd();
  const [row] = userId
    ? await db
        .select({
          allowanceUsd: spendAccounts.allowanceUsd,
          spentUsd: spendAccounts.spentUsd,
          runs: spendAccounts.runs,
        })
        .from(spendAccounts)
        .where(and(eq(spendAccounts.orgId, orgId), eq(spendAccounts.userId, userId)))
        .limit(1)
    : [];
  return {
    spent: row?.spentUsd ?? 0,
    allowance: fallback > 0 ? effectiveAllowance(row?.allowanceUsd ?? null, fallback) : null,
    runs: row?.runs ?? 0,
  };
}
