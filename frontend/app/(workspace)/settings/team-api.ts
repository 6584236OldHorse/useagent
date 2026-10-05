import { backendFetch } from "@/lib/backend-fetch";

/**
 * The organisation membership endpoints better-auth serves under /api/auth,
 * plus our own pending-invitations read. Every call names the organisation
 * explicitly: a fresh session has no active organisation until something sets
 * one, and the rest of the app falls back to the person's first membership, so
 * this does the same. Reads throw on a non-2xx so the card can say "could not
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
  // better-auth stores comma-separated roles; the first one is the person's rank here.
  const first = typeof value === "string" ? value.split(",")[0]?.trim() : "";
  return first === "owner" || first === "admin" ? first : "member";
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

/** The session's active organisation, else the first one the person belongs to. */
export async function resolveOrganizationId(activeOrganizationId: string | null | undefined): Promise<string> {
  if (activeOrganizationId) return activeOrganizationId;
  const res = await backendFetch("/api/auth/organization/list", { cache: "no-store" });
  if (!res.ok) throw new Error(`organization list ${res.status}`);
  const orgs = (await res.json()) as Array<{ id: string }> | null;
  const first = orgs?.[0]?.id;
  if (!first) throw new Error("no organisation");
  return first;
}

export async function fetchTeam(input: {
  readonly userId: string | null;
  readonly activeOrganizationId: string | null | undefined;
}): Promise<Team> {
  const organizationId = await resolveOrganizationId(input.activeOrganizationId);
  const [membersRes, invitationsRes] = await Promise.all([
    backendFetch(`/api/auth/organization/list-members?organizationId=${encodeURIComponent(organizationId)}`, { cache: "no-store" }),
    backendFetch("/api/team/invitations", { cache: "no-store" }),
  ]);
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
  if (!invitationsRes.ok) throw new Error(`invitations ${invitationsRes.status}`);
  const invitationsBody = (await invitationsRes.json()) as {
    invitations?: Array<{ id: string; email: string; role: string | null; expiresAt: string }>;
  };
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
