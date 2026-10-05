import { runtimeDevModeEnabled } from "../security/runtime-secrets";

/**
 * Who may open the component lab (/lab). Development keeps it open; production
 * admits only the accounts listed in LAB_ACCOUNTS (comma separated emails).
 */
export function labAccessAllowed(
  email: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (runtimeDevModeEnabled(env)) return true;
  if (!email) return false;
  const accounts = (env.LAB_ACCOUNTS ?? "")
    .split(",")
    .map((account) => account.trim().toLowerCase())
    .filter(Boolean);
  return accounts.includes(email.trim().toLowerCase());
}
