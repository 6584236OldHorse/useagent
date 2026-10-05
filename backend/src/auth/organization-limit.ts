import { sql } from "drizzle-orm";
import { db } from "../db/client";
import { accountOnList } from "../security/account-allowlist";

/** How many organisations one person may create, their personal one included:
 *  ORG_CREATE_LIMIT_PER_USER, a positive whole number, else 2. */
export function orgCreateLimitPerUser(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.ORG_CREATE_LIMIT_PER_USER);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 2;
}

/**
 * The organization plugin's limit check: true refuses the create. An
 * organisation counts as the person's when they are its first member (its
 * creator joins with it; everyone invited joins later), so joining by
 * invitation never uses the allowance. The accounts that run the deployment
 * (OPERATOR_ACCOUNTS) have no limit.
 * ponytail: two creates racing past the count can both land; the sandbox
 * minutes cap is per person, so an extra organisation brings no allowance.
 */
export async function organizationLimitReached(
  person: { readonly id: string; readonly email: string },
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  if (accountOnList("OPERATOR_ACCOUNTS", person.email, env)) return false;
  const [row] = await db.execute(sql`
    select count(*)::int as created from member mine
    where mine.user_id = ${person.id} and not exists (
      select 1 from member earlier
      where earlier.organization_id = mine.organization_id
        and (earlier.created_at, earlier.id) < (mine.created_at, mine.id))`);
  return Number(row?.created ?? 0) >= orgCreateLimitPerUser(env);
}
