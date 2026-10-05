import type { Context, Next } from "hono";

import { resolveSession } from "../auth/session";
import type { AppEnv } from "../http";
import { accountListed } from "../security/account-allowlist";

/**
 * Who runs this deployment. Where sandboxes come from (the vendor the server
 * points at, the optional vendor accounts, the provider preference) is the
 * operator's business: only the accounts in OPERATOR_ACCOUNTS (comma separated
 * emails) see or change it, and everyone else reads a plain "Cloud".
 * Development keeps it open, like the lab.
 */
export function operatorAccessAllowed(
  email: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return accountListed("OPERATOR_ACCOUNTS", email, env);
}

/** The signed-in account behind this request is an operator. An API key or the
 *  dev identity carries no email, so outside development it is not. */
export async function requestFromOperator(c: Context<AppEnv>): Promise<boolean> {
  const session = c.get("identitySource") === "session" ? await resolveSession(c.req.raw.headers) : null;
  return operatorAccessAllowed(session?.user.email);
}

/** Middleware for operator-only routes: anyone else gets the same 404 as a
 *  route that does not exist. Mount after orgScope. */
export async function operatorOnly(c: Context<AppEnv>, next: Next) {
  if (!(await requestFromOperator(c))) return c.json({ error: "not_found" }, 404);
  return next();
}
