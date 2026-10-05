import { accountListed } from "../security/account-allowlist";

/**
 * Who may open the component lab (/lab). Development keeps it open; production
 * admits only the accounts listed in LAB_ACCOUNTS (comma separated emails).
 */
export function labAccessAllowed(
  email: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return accountListed("LAB_ACCOUNTS", email, env);
}
