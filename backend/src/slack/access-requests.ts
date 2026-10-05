/**
 * A Slack sender the bot does not know yet. Instead of running their message as
 * somebody else, the bot records who asked, tells the workspace admins, and waits.
 * Allow creates the member (a new account when the address is new) and binds the
 * Slack sender to it, so their next message runs as themselves. Deny is remembered.
 */
import { and, eq } from "drizzle-orm";
import { INVITATION_MAIL_TIMEOUT_MS, headerSafe, invitationMailConfig } from "../auth-invitations";
import { sendSmtp } from "../connectors/email/smtp";
import { db } from "../db/client";
import { member, organization, user } from "../db/auth-schema";
import { slackAccessRequests, slackUsers } from "../db/schema";
import { env } from "../env";
import type { SlackClient } from "./client";
import { enqueuePostMessage } from "./outbox";
import { upsertSlackUser } from "./workspaces";

export type AccessRequestVerdict = "asked" | "waiting" | "denied";

const roles = (value: string | null | undefined) => (value ?? "").split(",").map((role) => role.trim());
const manages = (role: string | null | undefined) => roles(role).some((r) => r === "owner" || r === "admin");

/** Record the request once and tell the admins who are reachable on Slack. */
export async function requestSlackAccess(input: {
  teamId: string;
  slackUserId: string;
  orgId: string;
  client: SlackClient;
}): Promise<AccessRequestVerdict> {
  const [existing] = await db
    .select({ status: slackAccessRequests.status })
    .from(slackAccessRequests)
    .where(and(eq(slackAccessRequests.teamId, input.teamId), eq(slackAccessRequests.slackUserId, input.slackUserId)))
    .limit(1);
  if (existing?.status === "denied") return "denied";
  if (existing) return "waiting";

  const profile = (await input.client.userInfo?.({ user: input.slackUserId })) ?? null;
  const name = profile?.name ?? input.slackUserId;
  const id = crypto.randomUUID();
  await db
    .insert(slackAccessRequests)
    .values({ id, teamId: input.teamId, slackUserId: input.slackUserId, orgId: input.orgId, name, email: profile?.email ?? null, image: profile?.image ?? null })
    .onConflictDoNothing();

  const admins = await db
    .select({ slackUserId: slackUsers.slackUserId, role: member.role })
    .from(slackUsers)
    .innerJoin(member, and(eq(member.userId, slackUsers.userId), eq(member.organizationId, input.orgId)))
    .where(and(eq(slackUsers.teamId, input.teamId), eq(slackUsers.orgId, input.orgId)));
  const who = profile?.email ? `${name} (${profile.email})` : name;
  for (const admin of admins) {
    if (!manages(admin.role)) continue;
    await enqueuePostMessage({
      idempotencyKey: `slack-access-request:${id}:${admin.slackUserId}`,
      orgId: input.orgId,
      teamId: input.teamId,
      channel: admin.slackUserId,
      text: `${who} asked to use useAgent from Slack. Let them in or not: ${env.FRONTEND_ORIGIN}/settings#team`,
    });
  }
  return "asked";
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

export type AccessDecision = "allowed" | "denied" | "not_found" | "email_required";

/** Allow or deny a pending request. Allow needs an email: the person signs in on
 *  the web with it, and it is where the welcome goes when mail is configured. */
export async function decideAccessRequest(input: {
  id: string;
  orgId: string;
  decidedBy: string;
  allow: boolean;
  email?: string | null;
}): Promise<AccessDecision> {
  const [row] = await db
    .select()
    .from(slackAccessRequests)
    .where(and(eq(slackAccessRequests.id, input.id), eq(slackAccessRequests.orgId, input.orgId), eq(slackAccessRequests.status, "pending")))
    .limit(1);
  if (!row) return "not_found";
  const decided = { decidedBy: input.decidedBy, decidedAt: new Date() };
  if (!input.allow) {
    await db.update(slackAccessRequests).set({ status: "denied", ...decided }).where(eq(slackAccessRequests.id, row.id));
    return "denied";
  }
  const email = (input.email ?? row.email ?? "").trim().toLowerCase();
  if (!email) return "email_required";

  const [known] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  const userId = known?.id ?? crypto.randomUUID();
  if (!known) {
    await db.insert(user).values({ id: userId, name: row.name, email, emailVerified: false, image: row.image });
  }
  const [membership] = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, input.orgId), eq(member.userId, userId)))
    .limit(1);
  if (!membership) {
    await db.insert(member).values({ id: `member_${crypto.randomUUID()}`, organizationId: input.orgId, userId, role: "member", createdAt: new Date() });
  }
  await upsertSlackUser({ teamId: row.teamId, slackUserId: row.slackUserId, orgId: input.orgId, userId });
  await db.update(slackAccessRequests).set({ status: "allowed", email, ...decided }).where(eq(slackAccessRequests.id, row.id));

  await enqueuePostMessage({
    idempotencyKey: `slack-access-allowed:${row.id}`,
    orgId: input.orgId,
    teamId: row.teamId,
    channel: row.slackUserId,
    text: "You are in. Mention me again and I will get to work.",
  });
  await welcome(email, input.orgId);
  return "allowed";
}

/** Best effort: the person can already work from Slack; the mail only tells them how to sign in on the web. */
async function welcome(email: string, orgId: string): Promise<void> {
  const config = invitationMailConfig();
  if (!config) return;
  const [org] = await db.select({ name: organization.name }).from(organization).where(eq(organization.id, orgId)).limit(1);
  const workspace = headerSafe(org?.name ?? "") || "your workspace";
  try {
    await sendSmtp(
      { host: config.host, port: config.port, secure: config.secure, user: config.user, pass: config.pass, timeoutMs: INVITATION_MAIL_TIMEOUT_MS },
      {
        from: config.from,
        to: [email],
        subject: `You can now use ${workspace} on useAgent`,
        text: [`An admin let you into ${workspace} on useAgent.`, "", `Sign in with this email address: ${env.FRONTEND_ORIGIN}/login`].join("\n"),
      },
    );
  } catch (error) {
    console.error(`[slack] welcome mail to ${email} failed:`, (error as Error).message);
  }
}
