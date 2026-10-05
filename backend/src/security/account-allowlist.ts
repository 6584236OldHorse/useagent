import { runtimeDevModeEnabled } from "./runtime-secrets";

/**
 * Whether `email` is on the comma separated account list the env var `listEnv`
 * names (trimmed, case-insensitive). An unset list names nobody, in every mode.
 */
export function accountOnList(
  listEnv: string,
  email: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!email) return false;
  const accounts = (env[listEnv] ?? "")
    .split(",")
    .map((account) => account.trim().toLowerCase())
    .filter(Boolean);
  return accounts.includes(email.trim().toLowerCase());
}

/**
 * The same list as an access gate: development admits everyone; production
 * admits only listed accounts, so an unset list admits nobody.
 */
export function accountListed(
  listEnv: string,
  email: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return runtimeDevModeEnabled(env) || accountOnList(listEnv, email, env);
}
