import { and, eq, gt, isNotNull } from "drizzle-orm";
import { sendSmtp } from "./connectors/email/smtp";
import { db, type Executor } from "./db/client";
import { account, invitation, user } from "./db/auth-schema";
import { env, googleAuthEnabled, type InvitationMailConfig, invitationMailConfig, selfSignupEnabled } from "./env";

/**
 * Organisation invitations, and the sign-up verification mail that shares
 * their transport. A closed deployment creates no accounts on its own; a
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

/** Where an invitation is accepted: the accept page lives on the frontend. */
export function invitationLink(id: string, origin: string = env.FRONTEND_ORIGIN): string {
  return new URL(`/accept-invitation/${encodeURIComponent(id)}`, origin).toString();
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

/** The library's link names the address; the account id binds it to the
 *  registration that asked for it, so a link from a claim that a later sign-up
 *  replaced cannot verify the newer claim (auth/signup-routes.ts checks it). */
export function verificationLink(url: string, userId: string): string {
  return `${url}&account=${encodeURIComponent(userId)}`;
}

export function verificationMessage(link: string): { subject: string; text: string } {
  return {
    subject: "Confirm your useAgent sign-up",
    text: [
      "You signed up for useAgent with this address. Confirm it to sign in:",
      "",
      link,
      "",
      "The link works for one hour. If you did not sign up just now, ignore this",
      "mail: without your confirmation the address opens no account.",
    ].join("\n"),
  };
}

export async function deliverVerification(
  email: string,
  link: string,
  config: InvitationMailConfig | null = invitationMailConfig(),
  send: typeof sendSmtp = sendSmtp,
): Promise<void> {
  // Open sign-up is refused without a transport (env.ts), so this only guards a
  // transport removed after boot; the person can ask again from the card.
  if (!config) throw new Error("no mail transport for sign-up verification");
  const message = verificationMessage(link);
  await send(
    {
      host: config.host,
      port: config.port,
      secure: config.secure,
      user: config.user,
      pass: config.pass,
      timeoutMs: INVITATION_MAIL_TIMEOUT_MS,
    },
    { from: config.from, to: [email], subject: message.subject, text: message.text },
  );
  console.log(`[auth] sign-up verification emailed to ${email}`);
}

export const NO_WAY_IN =
  "That address has no account with a password here, and this deployment cannot create one. Set up Google sign-in, or invite an address that already signs in with a password.";

/** Whether an invitation to this address can ever be used. Any deployment that
 *  creates accounts says yes; a closed one needs an account with a password,
 *  since a Google-only account from a time when Google was on has no way in. */
export async function canSignIn(email: string): Promise<boolean> {
  if (selfSignupEnabled() || googleAuthEnabled()) return true;
  const [known] = await db
    .select({ id: user.id })
    .from(user)
    .innerJoin(account, and(eq(account.userId, user.id), eq(account.providerId, "credential"), isNotNull(account.password)))
    .where(eq(user.email, email.trim().toLowerCase()))
    .limit(1);
  return known !== undefined;
}
