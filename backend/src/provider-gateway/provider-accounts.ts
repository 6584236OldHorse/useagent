import { eq } from "drizzle-orm";
import { user } from "../db/auth-schema";
import { db, type Executor } from "../db/client";
import type { EngineId } from "../db/schema";
import { PROVIDER_IDS, providerForEngine, type ProviderId } from "./provider";

type Env = Record<string, string | undefined>;

/**
 * Which accounts a model provider is offered to. PROVIDER_ACCOUNTS names the
 * restricted providers and their accounts:
 *   cerebras:owner@example.com,second@example.com;openai:third@example.com
 * A provider named there is offered only to the listed accounts (email, trimmed,
 * case-insensitive); a provider not named is open to everyone; unset or empty
 * changes nothing. Development gets no exception. To an account that is not
 * listed the provider does not exist: its models leave every catalog, a run on
 * one is refused like any unknown model, and Settings has no card for it.
 */
export function restrictedProviders(env: Env = process.env): ReadonlyMap<string, ReadonlySet<string>> {
  const restricted = new Map<string, Set<string>>();
  for (const entry of (env.PROVIDER_ACCOUNTS ?? "").split(";")) {
    const at = entry.indexOf(":");
    const provider = (at === -1 ? entry : entry.slice(0, at)).trim().toLowerCase();
    if (!provider) continue;
    const accounts = restricted.get(provider) ?? new Set<string>();
    for (const account of at === -1 ? [] : entry.slice(at + 1).split(",")) {
      const email = account.trim().toLowerCase();
      if (email) accounts.add(email);
    }
    // A provider named with no accounts is offered to nobody.
    restricted.set(provider, accounts);
  }
  return restricted;
}

export function providerOfferedTo(provider: string, email: string | null | undefined, env: Env = process.env): boolean {
  const accounts = restrictedProviders(env).get(provider);
  if (!accounts) return true;
  return Boolean(email) && accounts.has(email!.trim().toLowerCase());
}

export function modelOfferedTo(engine: EngineId, model: string, email: string | null | undefined, env: Env = process.env): boolean {
  const provider = providerForEngine(engine, model);
  return !provider || providerOfferedTo(provider, email, env);
}

/** The model providers this account may see, for Settings and the config manifest. */
export function providersOfferedTo(email: string | null | undefined, env: Env = process.env): ProviderId[] {
  return PROVIDER_IDS.filter((provider) => providerOfferedTo(provider, email, env));
}

export async function userEmail(userId: string, exec: Executor = db): Promise<string | null> {
  const [row] = await exec.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
  return row?.email ?? null;
}

/** The same rule for callers that hold a user id. The account is read only when
 *  the provider is restricted at all, so an unrestricted deployment pays nothing. */
export async function providerOfferedToUser(
  provider: string,
  userId: string | null | undefined,
  env: Env = process.env,
  emailOf: (userId: string) => Promise<string | null> = userEmail,
): Promise<boolean> {
  if (!restrictedProviders(env).has(provider)) return true;
  return providerOfferedTo(provider, userId ? await emailOf(userId) : null, env);
}

export async function modelOfferedToUser(
  engine: EngineId,
  model: string,
  userId: string | null | undefined,
  env: Env = process.env,
  emailOf: (userId: string) => Promise<string | null> = userEmail,
): Promise<boolean> {
  const provider = providerForEngine(engine, model);
  return !provider || providerOfferedToUser(provider, userId, env, emailOf);
}

/** The account to filter a catalog by: null (nobody's) unless something is
 *  restricted and the caller is a known user. */
export async function catalogAccount(
  userId: string | null | undefined,
  env: Env = process.env,
  emailOf: (userId: string) => Promise<string | null> = userEmail,
): Promise<string | null> {
  return restrictedProviders(env).size > 0 && userId ? emailOf(userId) : null;
}
