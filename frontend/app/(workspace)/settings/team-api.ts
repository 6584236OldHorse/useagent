import { backendFetch } from "@/lib/backend-fetch";

/**
 * The organisation membership endpoints better-auth serves under /api/auth,
 * plus our own pending-invitations read, which also names the organisation the
 * server scoped the request to; every other call carries that id explicitly,
 * since a fresh session has no active organisation of its own. Reads throw on a non-2xx so the card can say "could not
 * load"; writes throw with the server's message so the dialog can show why.
 */

export type MemberRole = "owner" | "admin" | "member";
export const MEMBER_ROLES: readonly MemberRole[] = ["owner", "admin", "member"];

export interface TeamMember {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly image: string | null;
  readonly role: MemberRole;
  readonly joinedAt: string;
}

export interface PendingInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: MemberRole;
  readonly expiresAt: string;
}

export interface Team {
  readonly organizationId: string;
  readonly members: readonly TeamMember[];
  readonly invitations: readonly PendingInvitation[];
  /** The signed-in person's role in this organisation; null when not a member. */
  readonly myRole: MemberRole | null;
}

const jsonHeaders = { "content-type": "application/json" } as const;

export function memberRole(value: unknown): MemberRole {
  // better-auth stores comma-separated roles and grants the union of them, so the
  // person's rank is the strongest role present.
  const roles = typeof value === "string" ? value.split(",").map((r) => r.trim()) : [];
  if (roles.includes("owner")) return "owner";
  if (roles.includes("admin")) return "admin";
  return "member";
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown; error?: unknown };
    const text = typeof body.message === "string" ? body.message : typeof body.error === "string" ? body.error : "";
    return text || fallback;
  } catch {
    return fallback;
  }
}

async function post(path: string, body: Record<string, unknown>, fallback: string): Promise<Response> {
  const res = await backendFetch(path, { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await readError(res, fallback));
  return res;
}

export async function fetchTeam(input: { readonly userId: string | null }): Promise<Team> {
  // The server resolves the organisation once (the request's org scope) and
  // names it, so members, invitations and every later write agree on one org.
  const invitationsRes = await backendFetch("/api/team/invitations", { cache: "no-store" });
  if (!invitationsRes.ok) throw new Error(`invitations ${invitationsRes.status}`);
  const invitationsBody = (await invitationsRes.json()) as {
    organizationId: string;
    invitations?: Array<{ id: string; email: string; role: string | null; expiresAt: string }>;
  };
  const organizationId = invitationsBody.organizationId;
  const membersRes = await backendFetch(
    `/api/auth/organization/list-members?organizationId=${encodeURIComponent(organizationId)}`,
    { cache: "no-store" },
  );
  if (!membersRes.ok) throw new Error(`list-members ${membersRes.status}`);
  const membersBody = (await membersRes.json()) as {
    members?: Array<{
      id: string;
      userId: string;
      role: string;
      createdAt: string;
      user?: { name?: string | null; email?: string | null; image?: string | null };
    }>;
  };
  const members = (membersBody.members ?? []).map((m) => ({
    id: m.id,
    userId: m.userId,
    name: m.user?.name?.trim() || m.user?.email || "Member",
    email: m.user?.email ?? "",
    image: m.user?.image ?? null,
    role: memberRole(m.role),
    joinedAt: m.createdAt,
  }));
  const invitations = (invitationsBody.invitations ?? []).map((i) => ({
    id: i.id,
    email: i.email,
    role: memberRole(i.role),
    expiresAt: i.expiresAt,
  }));
  const mine = input.userId ? members.find((m) => m.userId === input.userId) : undefined;
  return { organizationId, members, invitations, myRole: mine?.role ?? null };
}

/** Owners and admins manage people; the check mirrors the server's default access control. */
export function canManageTeam(role: MemberRole | null): boolean {
  return role === "owner" || role === "admin";
}

/** A fresh invitation. When one is already pending for that email the server
 * says so, and the pending row offers resend or cancel. */
export async function inviteMember(organizationId: string, email: string, role: MemberRole): Promise<PendingInvitation> {
  const res = await post(
    "/api/auth/organization/invite-member",
    { organizationId, email, role, resend: false },
    "Could not send the invitation.",
  );
  const body = (await res.json()) as { id: string; email: string; role: string | null; expiresAt: string };
  return { id: body.id, email: body.email, role: memberRole(body.role), expiresAt: body.expiresAt };
}

/** Extends the pending invitation and sends the mail again; the role stays as invited. */
export async function resendInvitation(organizationId: string, invitation: PendingInvitation): Promise<void> {
  await post(
    "/api/auth/organization/invite-member",
    { organizationId, email: invitation.email, role: invitation.role, resend: true },
    "Could not resend the invitation.",
  );
}

export async function cancelInvitation(organizationId: string, invitationId: string): Promise<void> {
  await post("/api/auth/organization/cancel-invitation", { organizationId, invitationId }, "Could not cancel the invitation.");
}

export async function updateMemberRole(organizationId: string, memberId: string, role: MemberRole): Promise<void> {
  await post("/api/auth/organization/update-member-role", { organizationId, memberId, role }, "Could not change the role.");
}

export async function removeMember(organizationId: string, memberId: string): Promise<void> {
  await post("/api/auth/organization/remove-member", { organizationId, memberIdOrEmail: memberId }, "Could not remove the member.");
}

/** The link an inviter can hand over when the deployment sends no mail. */
export function invitationHref(invitationId: string, origin: string): string {
  return new URL(`/accept-invitation/${encodeURIComponent(invitationId)}`, origin).toString();
}
