/**
 * A Slack sender the bot does not know yet. Instead of running their message as
 * somebody else, the bot records who asked, tells the workspace admins, and waits.
 * Allow creates the member (a new account when the address is new) and binds the
 * Slack sender to it, so their next message runs as themselves. Deny is remembered.
 *
 * Who an address belongs to is decided by evidence, not by typing: a sender who
 * already owns a binding here is that account; an address Slack itself reported
 * for the sender may match an existing account; an address an admin typed may
 * only create a new one, never attach a stranger to somebody's account.
 */
import { and, eq } from "drizzle-orm";
import { INVITATION_MAIL_TIMEOUT_MS, headerSafe, invitationMailConfig } from "../auth-invitations";
import { sendSmtp } from "../connectors/email/smtp";
import { db, type Executor } from "../db/client";
import { member, organization, user } from "../db/auth-schema";
import { slackAccessRequests, slackUsers, slackWorkspaces } from "../db/schema";
import { env, googleAuthEnabled } from "../env";
import type { SlackClient } from "./client";
import { kickSlackOutbox } from "./outbox/delivery";
import { enqueuePostMessageTx } from "./outbox";
import { findActiveSlackUser, upsertSlackUser } from "./workspaces";

export type AccessRequestVerdict = "asked" | "waiting" | "denied" | "already_in";

const roles = (value: string | null | undefined) => (value ?? "").split(",").map((role) => role.trim());
const manages = (role: string | null | undefined) => roles(role).some((r) => r === "owner" || r === "admin");
/** One rule for every address source: no whitespace or control characters, bounded, one @ with a dot after it. */
export function validEmail(value: string | null | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    /^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+\.[^\s@\u0000-\u001f\u007f]+$/.test(value)
  );
}

/** Record the request once and tell the admins who are reachable on Slack. The
 *  row and the notices commit together, so a failed notice is never lost behind
 *  a row that says "already asked". */
export async function requestSlackAccess(input: {
  teamId: string;
  slackUserId: string;
  orgId: string;
  /** The Slack message that asked; a retried delivery of it sends no second notice. */
  messageTs: string;
  client: SlackClient;
}): Promise<AccessRequestVerdict> {
  const sender = and(
    eq(slackAccessRequests.teamId, input.teamId),
    eq(slackAccessRequests.slackUserId, input.slackUserId),
    eq(slackAccessRequests.orgId, input.orgId),
  );
  const [existing] = await db
    .select({ id: slackAccessRequests.id, status: slackAccessRequests.status })
    .from(slackAccessRequests)
    .where(sender)
    .limit(1);
  if (existing?.status === "denied") return "denied";
  if (existing?.status === "pending") return "waiting";

  const profile = (await input.client.userInfo?.({ user: input.slackUserId })) ?? null;
  const name = profile?.name ?? input.slackUserId;
  const email = validEmail(profile?.email) ? profile.email : null;
  const admins = await db
    .select({ slackUserId: slackUsers.slackUserId, role: member.role })
    .from(slackUsers)
    .innerJoin(member, and(eq(member.userId, slackUsers.userId), eq(member.organizationId, input.orgId)))
    .where(and(eq(slackUsers.teamId, input.teamId), eq(slackUsers.orgId, input.orgId)));
  const who = email ? `${name} (${email})` : name;
  const id = existing?.id ?? crypto.randomUUID();
  const verdict = await db.transaction(async (tx): Promise<AccessRequestVerdict> => {
    const [locked] = existing
      ? await tx.select({ status: slackAccessRequests.status }).from(slackAccessRequests).where(eq(slackAccessRequests.id, existing.id)).for("update")
      : [];
    if (locked?.status === "denied") return "denied";
    if (locked?.status === "pending") return "waiting";
    if (locked) {
      // Allowed once. A stale event from before the decision must not reopen a
      // live membership; only a membership that is gone asks again.
      const active = await findActiveSlackUser(input.teamId, input.slackUserId, tx);
      if (active?.orgId === input.orgId) return "already_in";
      await tx.update(slackAccessRequests).set({ status: "pending", name, email, image: profile?.image ?? null, decidedBy: null, decidedAt: null }).where(eq(slackAccessRequests.id, existing!.id));
    } else {
      await tx.insert(slackAccessRequests).values({ id, teamId: input.teamId, slackUserId: input.slackUserId, orgId: input.orgId, name, email, image: profile?.image ?? null });
    }
    for (const admin of admins) {
      if (!manages(admin.role)) continue;
      await enqueuePostMessageTx(tx, {
        idempotencyKey: `slack-access-request:${id}:${admin.slackUserId}:${input.messageTs}`,
        orgId: input.orgId,
        teamId: input.teamId,
        channel: admin.slackUserId,
        text: `${who} asked to use useAgent from Slack. Let them in or not: ${env.FRONTEND_ORIGIN}/settings#team`,
      });
    }
    return "asked";
  });
  if (verdict === "asked") kickSlackOutbox();
  return verdict;
}

export interface AccessRequestRow {
  id: string;
  slackUserId: string;
  name: string;
  email: string | null;
  image: string | null;
  createdAt: string;
}

export async function listAccessRequests(orgId: string): Promise<AccessRequestRow[]> {
  const rows = await db
    .select({
      id: slackAccessRequests.id,
      slackUserId: slackAccessRequests.slackUserId,
      name: slackAccessRequests.name,
      email: slackAccessRequests.email,
      image: slackAccessRequests.image,
      createdAt: slackAccessRequests.createdAt,
    })
    .from(slackAccessRequests)
    .where(and(eq(slackAccessRequests.orgId, orgId), eq(slackAccessRequests.status, "pending")))
    .limit(200);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export type AccessDecision = "allowed" | "denied" | "not_found" | "email_required" | "email_invalid" | "account_exists";

/** Allow or deny a pending request, in one transaction on a locked row, so two
 *  admins answering at once cannot leave a denied sender bound. */
export async function decideAccessRequest(input: {
  id: string;
  orgId: string;
  decidedBy: string;
  allow: boolean;
  email?: string | null;
}): Promise<AccessDecision> {
  const typed = (input.email ?? "").trim().toLowerCase();
  if (typed && !validEmail(typed)) return "email_invalid";
  const outcome = await db.transaction(async (tx): Promise<AccessDecision> => {
    const [pending] = await tx
      .select({ teamId: slackAccessRequests.teamId })
      .from(slackAccessRequests)
      .where(and(eq(slackAccessRequests.id, input.id), eq(slackAccessRequests.orgId, input.orgId), eq(slackAccessRequests.status, "pending")))
      .limit(1);
    if (!pending) return "not_found";
    // Workspace first, then the request: a rebinding to another org waits for
    // this decision, and a workspace already rebound keeps nothing from here.
    const [workspace] = await tx
      .select({ orgId: slackWorkspaces.orgId })
      .from(slackWorkspaces)
      .where(eq(slackWorkspaces.teamId, pending.teamId))
      .for("update");
    if (workspace?.orgId !== input.orgId) return "not_found";
    const [row] = await tx
      .select()
      .from(slackAccessRequests)
      .where(and(eq(slackAccessRequests.id, input.id), eq(slackAccessRequests.orgId, input.orgId), eq(slackAccessRequests.status, "pending")))
      .for("update");
    if (!row) return "not_found";
    const decided = { decidedBy: input.decidedBy, decidedAt: new Date() };
    if (!input.allow) {
      await tx.update(slackAccessRequests).set({ status: "denied", ...decided }).where(eq(slackAccessRequests.id, row.id));
      return "denied";
    }
    const userId = await identityFor(tx, row, typed);
    if (userId === "email_required" || userId === "email_invalid" || userId === "account_exists") return userId;
    const [membership] = await tx
      .select({ id: member.id })
      .from(member)
      .where(and(eq(member.organizationId, input.orgId), eq(member.userId, userId)))
      .limit(1);
    if (!membership) {
      await tx.insert(member).values({ id: `member_${crypto.randomUUID()}`, organizationId: input.orgId, userId, role: "member", createdAt: new Date() });
    }
    await upsertSlackUser({ teamId: row.teamId, slackUserId: row.slackUserId, orgId: input.orgId, userId }, tx);
    await tx.update(slackAccessRequests).set({ status: "allowed", ...decided }).where(eq(slackAccessRequests.id, row.id));
    await enqueuePostMessageTx(tx, {
      idempotencyKey: `slack-access-allowed:${row.id}:${decided.decidedAt.getTime()}`,
      orgId: input.orgId,
      teamId: row.teamId,
      channel: row.slackUserId,
      text: "You are in. Mention me again and I will get to work.",
    });
    return "allowed";
  });
  if (outcome === "allowed") {
    kickSlackOutbox();
    await welcome(input.orgId, input.id);
  }
  return outcome;
}

type Request = typeof slackAccessRequests.$inferSelect;

/** Which account the sender is. Returns the user id, or why none can be chosen. */
async function identityFor(tx: Executor, row: Request, typed: string): Promise<string | "email_required" | "email_invalid" | "account_exists"> {
  const [bound] = await tx
    .select({ userId: slackUsers.userId })
    .from(slackUsers)
    .where(and(eq(slackUsers.teamId, row.teamId), eq(slackUsers.slackUserId, row.slackUserId), eq(slackUsers.orgId, row.orgId)))
    .limit(1);
  if (bound) return bound.userId; // the account this sender already owns here
  const email = row.email ?? typed; // Slack's word about the sender beats the admin's typing
  if (!email) return "email_required";
  if (!validEmail(email)) return "email_invalid";
  const [known] = await tx.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  if (known) {
    if (!row.email) return "account_exists"; // typed by an admin: no proof this sender is that person
    return known.id;
  }
  const id = crypto.randomUUID();
  await tx.insert(user).values({ id, name: row.name, email, emailVerified: false, image: row.image });
  return id;
}

/** Best effort, and only when the web has a way for them in: a Google sign-in
 *  with this address links the account. Self sign-up cannot, the address is
 *  taken. The person can already work from Slack either way. */
async function welcome(orgId: string, requestId: string): Promise<void> {
  const config = invitationMailConfig();
  if (!config || !googleAuthEnabled()) return;
  const [row] = await db
    .select({ email: slackAccessRequests.email, userId: slackUsers.userId })
    .from(slackAccessRequests)
    .innerJoin(slackUsers, and(eq(slackUsers.teamId, slackAccessRequests.teamId), eq(slackUsers.slackUserId, slackAccessRequests.slackUserId), eq(slackUsers.orgId, slackAccessRequests.orgId)))
    .where(eq(slackAccessRequests.id, requestId))
    .limit(1);
  if (!row) return;
  const [account] = await db.select({ email: user.email }).from(user).where(eq(user.id, row.userId)).limit(1);
  const [org] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, orgId)).limit(1);
  const workspace = headerSafe(org?.name ?? "") || "your workspace";
  if (!account) return;
  try {
    await sendSmtp(
      { host: config.host, port: config.port, secure: config.secure, user: config.user, pass: config.pass, timeoutMs: INVITATION_MAIL_TIMEOUT_MS },
      {
        from: config.from,
        to: [account.email],
        subject: `You can now use ${workspace} on useAgent`,
        text: [`An admin let you into ${workspace} on useAgent.`, "", `Sign in with this email address: ${env.FRONTEND_ORIGIN}/login`].join("\n"),
      },
    );
  } catch (error) {
    console.error(`[slack] welcome mail for request ${requestId} failed:`, (error as Error).message);
  }
}
