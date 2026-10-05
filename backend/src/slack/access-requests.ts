/**
 * A Slack sender the bot does not know yet. Instead of running their message as
 * somebody else, the bot records who asked, tells the workspace admins, and waits.
 * Allow creates the member (a new account when the address is new) and binds the
 * Slack sender to it, so their next message runs as themselves. Deny is remembered.
 *
 * Who an address belongs to is decided by evidence, not by typing. A sender who
 * already owns a binding here is that account. An address Slack itself reported
 * for the sender may match an existing account or create one, and the sender is
 * bound at once. An address an admin typed is only an invitation: the binding is
 * made when the person who owns that address accepts it on the web, so a typed
 * address can never claim somebody else's identity. Deny is remembered.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import { INVITATION_EXPIRES_IN_SECONDS, INVITATION_MAIL_TIMEOUT_MS, canSignIn, deliverInvitation, headerSafe, invitationMailConfig } from "../auth-invitations";
import { sendSmtp } from "../connectors/email/smtp";
import { db, type Executor } from "../db/client";
import { invitation, member, organization, user } from "../db/auth-schema";
import { slackAccessRequests, slackUsers, slackWorkspaces } from "../db/schema";
import { env, googleAuthEnabled } from "../env";
import type { SlackClient } from "./client";
import { kickSlackOutbox } from "./outbox/delivery";
import { enqueuePostMessageTx } from "./outbox";
import { findActiveSlackUser, upsertSlackUser } from "./workspaces";

export type AccessRequestVerdict = "asked" | "waiting" | "invited" | "denied" | "already_in";

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

async function invitationOpen(id: string | null, exec: Executor): Promise<boolean> {
  if (!id) return false;
  const [row] = await exec
    .select({ id: invitation.id })
    .from(invitation)
    .where(and(eq(invitation.id, id), eq(invitation.status, "pending"), gt(invitation.expiresAt, new Date())))
    .limit(1);
  return row !== undefined;
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
    .select({ id: slackAccessRequests.id, status: slackAccessRequests.status, email: slackAccessRequests.email, invitationId: slackAccessRequests.invitationId })
    .from(slackAccessRequests)
    .where(sender)
    .limit(1);
  if (existing?.status === "denied") return "denied";
  // A pending request that already carries Slack's word about the address needs
  // nothing more; one without it gets another look, in case the lookup failed.
  if (existing?.status === "pending" && existing.email) return "waiting";
  if (existing?.status === "invited" && (await invitationOpen(existing.invitationId, db))) return "invited";

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
      ? await tx.select({ status: slackAccessRequests.status, invitationId: slackAccessRequests.invitationId }).from(slackAccessRequests).where(eq(slackAccessRequests.id, existing.id)).for("update")
      : [];
    if (locked?.status === "denied") return "denied";
    if (locked?.status === "pending") {
      // Whatever the lookup recovered this time is kept: a name and avatar
      // without an address still help the admins, and a null address stays
      // open for the next look.
      if (profile) {
        await tx.update(slackAccessRequests).set({ name, email, image: profile.image }).where(and(eq(slackAccessRequests.id, existing!.id), isNull(slackAccessRequests.email)));
      }
      return "waiting";
    }
    if (locked?.status === "invited" && (await invitationOpen(locked.invitationId, tx))) return "invited";
    if (locked?.status === "allowed") {
      // A stale event from before the decision must not reopen a live
      // membership; only a membership that is gone asks again.
      const active = await findActiveSlackUser(input.teamId, input.slackUserId, tx);
      if (active?.orgId === input.orgId) return "already_in";
    }
    if (locked) {
      // Allowed once and gone, or invited and the invitation lapsed: ask again,
      // keeping what was known about them unless the lookup brought more.
      await tx
        .update(slackAccessRequests)
        .set({ status: "pending", ...(profile ? { name, email, image: profile.image } : {}), invitationId: null, decidedBy: null, decidedAt: null })
        .where(eq(slackAccessRequests.id, existing!.id));
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
    // Only while the workspace still belongs here: a request from a workspace
    // since rebound to another org can no longer be answered by this one.
    .innerJoin(slackWorkspaces, and(eq(slackWorkspaces.teamId, slackAccessRequests.teamId), eq(slackWorkspaces.orgId, slackAccessRequests.orgId)))
    .where(and(eq(slackAccessRequests.orgId, orgId), eq(slackAccessRequests.status, "pending")))
    .limit(200);
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

export type AccessDecision = "allowed" | "invited" | "denied" | "not_found" | "email_required" | "email_invalid" | "no_way_in";

/** Allow or deny a pending request, in one transaction on a locked row, so two
 *  admins answering at once cannot leave a denied sender bound. */
export async function decideAccessRequest(input: {
  id: string;
  orgId: string;
  decidedBy: { id: string; name: string; email: string };
  allow: boolean;
  email?: string | null;
}): Promise<AccessDecision> {
  const typed = (input.email ?? "").trim().toLowerCase();
  if (typed && !validEmail(typed)) return "email_invalid";
  let invited: { id: string; email: string; expiresAt: Date } | null = null;
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
    const decided = { decidedBy: input.decidedBy.id, decidedAt: new Date() };
    if (!input.allow) {
      await tx.update(slackAccessRequests).set({ status: "denied", ...decided }).where(eq(slackAccessRequests.id, row.id));
      return "denied";
    }

    const userId = await provenIdentity(tx, row);
    if (!userId) {
      // Only the admin's word about the address: an invitation, which binds the
      // sender when the address's owner accepts it on the web.
      if (!typed) return "email_required";
      if (!(await canSignIn(typed))) return "no_way_in";
      invited = { id: crypto.randomUUID(), email: typed, expiresAt: new Date(Date.now() + INVITATION_EXPIRES_IN_SECONDS * 1000) };
      await tx.insert(invitation).values({ ...invited, organizationId: input.orgId, role: "member", status: "pending", inviterId: input.decidedBy.id });
      await tx.update(slackAccessRequests).set({ status: "invited", email: typed, invitationId: invited.id, ...decided }).where(eq(slackAccessRequests.id, row.id));
      return "invited";
    }
    await admit(tx, { orgId: input.orgId, teamId: row.teamId, slackUserId: row.slackUserId, userId });
    await tx.update(slackAccessRequests).set({ status: "allowed", ...decided }).where(eq(slackAccessRequests.id, row.id));
    return "allowed";
  });
  if (outcome === "allowed") {
    kickSlackOutbox();
    await welcome(input.orgId, input.id);
  }
  if (outcome === "invited" && invited) {
    const sent: { id: string; email: string; expiresAt: Date } = invited;
    const [org] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, input.orgId)).limit(1);
    try {
      await deliverInvitation({
        id: sent.id,
        email: sent.email,
        role: "member",
        organization: { name: org?.name ?? "" },
        invitation: { expiresAt: sent.expiresAt },
        inviter: { user: { name: input.decidedBy.name, email: input.decidedBy.email } },
      });
    } catch (error) {
      console.error(`[slack] invitation ${sent.id} could not be sent:`, (error as Error).message);
    }
  }
  return outcome;
}

/** The person who accepted an invitation an admin sent on a Slack sender's
 *  behalf now owns that sender: bind them and tell them on Slack. */
export async function bindInvitedSlackSender(invitationId: string, userId: string): Promise<boolean> {
  const bound = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(slackAccessRequests)
      .where(and(eq(slackAccessRequests.invitationId, invitationId), eq(slackAccessRequests.status, "invited")))
      .for("update");
    if (!row) return false;
    await admit(tx, { orgId: row.orgId, teamId: row.teamId, slackUserId: row.slackUserId, userId });
    await tx.update(slackAccessRequests).set({ status: "allowed" }).where(eq(slackAccessRequests.id, row.id));
    return true;
  });
  if (bound) kickSlackOutbox();
  return bound;
}

/** Member row if missing, the binding, and the Slack reply, in the caller's transaction. */
async function admit(tx: Executor, input: { orgId: string; teamId: string; slackUserId: string; userId: string }): Promise<void> {
  const [membership] = await tx
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, input.orgId), eq(member.userId, input.userId)))
    .limit(1);
  if (!membership) {
    await tx.insert(member).values({ id: `member_${crypto.randomUUID()}`, organizationId: input.orgId, userId: input.userId, role: "member", createdAt: new Date() });
  }
  await upsertSlackUser({ teamId: input.teamId, slackUserId: input.slackUserId, orgId: input.orgId, userId: input.userId }, tx);
  await enqueuePostMessageTx(tx, {
    idempotencyKey: `slack-access-allowed:${input.teamId}:${input.slackUserId}:${input.userId}`,
    orgId: input.orgId,
    teamId: input.teamId,
    channel: input.slackUserId,
    text: "You are in. Mention me again and I will get to work.",
  });
}

type Request = typeof slackAccessRequests.$inferSelect;

/** The account this sender provably is, or null when only an admin's typing says who they are. */
async function provenIdentity(tx: Executor, row: Request): Promise<string | null> {
  const [bound] = await tx
    .select({ userId: slackUsers.userId })
    .from(slackUsers)
    .where(and(eq(slackUsers.teamId, row.teamId), eq(slackUsers.slackUserId, row.slackUserId), eq(slackUsers.orgId, row.orgId)))
    .limit(1);
  if (bound) return bound.userId; // the account this sender already owns here
  if (!validEmail(row.email)) return null; // nothing from Slack about the address
  const [known] = await tx.select({ id: user.id }).from(user).where(eq(user.email, row.email)).limit(1);
  if (known) return known.id;
  const id = crypto.randomUUID();
  await tx.insert(user).values({ id, name: row.name, email: row.email, emailVerified: false, image: row.image });
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
