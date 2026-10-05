import { and, eq, gt } from "drizzle-orm";
import { sendSmtp } from "./connectors/email/smtp";
import { db, type Executor } from "./db/client";
import { invitation } from "./db/auth-schema";
import { env } from "./env";

/**
 * Organisation invitations. Production creates no accounts on its own; a
 * pending invitation is the one door in. The invite goes out as an email when
 * the deployment has an SMTP host, and is always available as a link the
 * inviter can hand over themselves.
 */

/** Seven days, in the seconds better-auth's organization plugin expects. */
export const INVITATION_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

/** A pending, unexpired invitation for this email lets the account be created. */
export async function invitedSignupAllowed(
  email: string,
  exec: Executor = db,
  now: Date = new Date(),
): Promise<boolean> {
  const [row] = await exec
    .select({ id: invitation.id })
    .from(invitation)
    .where(
      and(
        eq(invitation.email, email.trim().toLowerCase()),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, now),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Where an invitation is accepted: the app origin better-auth already serves. */
export function invitationLink(id: string, origin: string = env.BETTER_AUTH_URL): string {
  return new URL(`/accept-invitation/${encodeURIComponent(id)}`, origin).toString();
}

export interface InvitationMailConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user?: string;
  readonly pass?: string;
  readonly from: string;
}

/**
 * Account mail reuses the connector's SMTP settings (host, port, login, from)
 * without its recipient allow-list, since an invitation goes to a new address
 * by definition. The SMTP client speaks implicit TLS, so the default port is 465.
 * Null means no delivery: the UI shows the link instead.
 */
export function invitationMailConfig(
  source: Record<string, string | undefined> = process.env,
): InvitationMailConfig | null {
  const host = source.CONNECTOR_EMAIL_HOST?.trim();
  const from = source.CONNECTOR_EMAIL_FROM?.trim();
  if (!host || !from) return null;
  const port = Number(source.CONNECTOR_EMAIL_PORT ?? 465);
  if (!Number.isInteger(port) || port <= 0) return null;
  return {
    host,
    port,
    secure: source.CONNECTOR_EMAIL_SECURE === "true" || port === 465,
    user: source.CONNECTOR_EMAIL_USER?.trim() || undefined,
    pass: source.CONNECTOR_EMAIL_PASS || undefined,
    from,
  };
}

export function invitationMailEnabled(): boolean {
  return invitationMailConfig() !== null;
}

export interface InvitationNotice {
  readonly organization: string;
  readonly inviter: string;
  readonly role: string;
  readonly link: string;
  readonly expiresAt: Date;
}

/** Names are typed by people and end up in a mail header: one line, no control characters. */
export function headerSafe(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Longest a delivery may take before the invitation is left as link-only. */
export const INVITATION_MAIL_TIMEOUT_MS = 20_000;

export function invitationMessage(notice: InvitationNotice): { subject: string; text: string } {
  const role = notice.role === "admin" ? "an admin" : notice.role === "owner" ? "an owner" : "a member";
  const until = notice.expiresAt.toISOString().slice(0, 10);
  const inviter = headerSafe(notice.inviter) || "A teammate";
  const organization = headerSafe(notice.organization) || "a workspace";
  return {
    subject: `${inviter} invited you to ${organization} on useAgent`,
    text: [
      `${inviter} invited you to join ${organization} as ${role}.`,
      "",
      `Accept the invitation: ${notice.link}`,
      "",
      `Sign in with this email address. The link works until ${until}.`,
    ].join("\n"),
  };
}

/** What better-auth hands to sendInvitationEmail, narrowed to what the mail needs. */
export interface InvitationDelivery {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly organization: { readonly name: string };
  readonly invitation: { readonly expiresAt: Date };
  readonly inviter: { readonly user: { readonly name: string; readonly email: string } };
}

export async function deliverInvitation(
  data: InvitationDelivery,
  config: InvitationMailConfig | null = invitationMailConfig(),
  send: typeof sendSmtp = sendSmtp,
): Promise<"sent" | "link_only"> {
  // Rejections and timeouts propagate: better-auth logs them and keeps the invitation.
  const link = invitationLink(data.id);
  if (!config) {
    console.log(`[auth] invitation ${data.id} for ${data.email}: no mail transport, share ${link}`);
    return "link_only";
  }
  const message = invitationMessage({
    organization: data.organization.name,
    inviter: data.inviter.user.name.trim() || data.inviter.user.email,
    role: data.role,
    link,
    expiresAt: data.invitation.expiresAt,
  });
  // A stalled SMTP dialog must not hold the invite request or its socket; the
  // invitation row already exists and the link is shown whatever the mail did.
  await send(
    {
      host: config.host,
      port: config.port,
      secure: config.secure,
      user: config.user,
      pass: config.pass,
      timeoutMs: INVITATION_MAIL_TIMEOUT_MS,
    },
    { from: config.from, to: [data.email], subject: message.subject, text: message.text },
  );
  console.log(`[auth] invitation ${data.id} emailed to ${data.email}`);
  return "sent";
}
