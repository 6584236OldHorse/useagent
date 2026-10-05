import { and, eq, notExists } from "drizzle-orm";
import { account, session, user } from "./db/auth-schema";
import { db, type Executor } from "./db/client";
import { member, organization } from "./db/schema";

/**
 * Signup side-effects for better-auth. One job: give every newly-created user
 * (Google or email) their own organization on first sign-in, so they land in a
 * real tenant instead of borrowing the dev org. Single-team scope — one owner,
 * one org — mirroring the dev-seed insert shape (seed.ts).
 *
 * Best-effort: a failure here is logged but never aborts the signup. The org
 * middleware's `firstOrgForUser` fallback resolves the org on later requests,
 * and a genuinely org-less session still fails closed (403 no_organization)
 * rather than crossing tenancy — so a missed org degrades safely.
 */
export async function createPersonalOrgForUser(user: {
  id: string;
  name?: string | null;
  email: string;
}, exec: Executor = db): Promise<string | null> {
  const now = new Date();
  const label = (user.name?.trim() || user.email.split("@")[0] || "workspace").trim();

  try {
    const orgId = `org_${crypto.randomUUID()}`;
    await exec.insert(organization).values({
      id: orgId,
      name: `${label}'s workspace`,
      slug: `${slugify(label)}-${crypto.randomUUID().slice(0, 8)}`,
      createdAt: now,
    });
    await exec.insert(member).values({
      id: `member_${crypto.randomUUID()}`,
      organizationId: orgId,
      userId: user.id,
      role: "owner",
      createdAt: now,
    });
    return orgId;
  } catch (err) {
    console.error(
      `[auth] failed to create personal org for user ${user.id}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/** The personal organisation, once, whichever path reports the person: a
 *  confirmed sign-up, a provider identity linking, a second click on the same
 *  link, a development sign-up. Every such path takes the same lock first, the
 *  person's user row, and reads memberships under it in the same transaction:
 *  two paths cannot both find none, and none waits on anything but that row,
 *  so there is nothing to deadlock on. Given a transaction (confirmation holds
 *  the row already), it rides in it; otherwise it opens one. A person who
 *  already belongs somewhere keeps what they have. */
export async function ensurePersonalOrgForUser(
  person: { id: string; name?: string | null; email: string },
  exec: Executor = db,
): Promise<void> {
  const decide = async (tx: Executor): Promise<void> => {
    const [locked] = await tx.select({ id: user.id }).from(user).where(eq(user.id, person.id)).for("update");
    if (!locked) return; // gone in between: nobody to give a workspace to
    const [membership] = await tx.select({ id: member.id }).from(member).where(eq(member.userId, person.id)).limit(1);
    if (!membership) await createPersonalOrgForUser(person, tx);
  };
  if (exec === db) await db.transaction(decide);
  else await decide(exec);
}

/** The user rows that are a claim on an address rather than a person: the
 *  address never confirmed, no organisation, never signed in. Only an open
 *  sign-up produces such rows; provisioned, invited and development accounts
 *  have their organisation from creation. */
export const claimCondition = and(
  eq(user.emailVerified, false),
  notExists(db.select({ id: member.id }).from(member).where(eq(member.userId, user.id))),
  notExists(db.select({ id: session.id }).from(session).where(eq(session.userId, user.id))),
);

/** Whether the account still has a password to sign in with. */
export async function hasCredential(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "credential")))
    .limit(1);
  return row !== undefined;
}

export async function unverifiedClaim(userId: string): Promise<boolean> {
  const [row] = await db.select({ id: user.id }).from(user).where(and(eq(user.id, userId), claimCondition)).limit(1);
  return row !== undefined;
}

/** Lowercase, hyphenate, and bound a label into a DNS-ish org slug stem. */
function slugify(label: string): string {
  const stem = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return stem || "workspace";
}
