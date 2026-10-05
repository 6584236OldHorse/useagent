import { backendFetch } from "@/lib/backend-fetch";

/**
 * The organisation membership endpoints better-auth serves under /api/auth.
 * Every call works on the session's active organisation, so no id is sent.
 * Reads throw on a non-2xx so the card can show "could not load"; writes throw
 * with the server's message so the dialog can show why.
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

export async function fetchTeam(): Promise<Team> {
  const [membersRes, invitationsRes, meRes] = await Promise.all([
    backendFetch("/api/auth/organization/list-members", { cache: "no-store" }),
    backendFetch("/api/auth/organization/list-invitations", { cache: "no-store" }),
    backendFetch("/api/auth/organization/get-active-member", { cache: "no-store" }),
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
  // A member may not list invitations; that is an empty list, not an error.
  const invitationsBody = invitationsRes.ok
    ? ((await invitationsRes.json()) as Array<{ id: string; email: string; role: string | null; status: string; expiresAt: string }>)
    : [];
  const invitations = (Array.isArray(invitationsBody) ? invitationsBody : [])
    .filter((i) => i.status === "pending" && Date.parse(i.expiresAt) > Date.now())
    .map((i) => ({ id: i.id, email: i.email, role: memberRole(i.role), expiresAt: i.expiresAt }));
  const myRole = meRes.ok ? memberRole(((await meRes.json()) as { role?: string }).role) : null;
  return { members, invitations, myRole };
}

/** Owners and admins manage people; the check mirrors the server's default access control. */
export function canManageTeam(role: MemberRole | null): boolean {
  return role === "owner" || role === "admin";
}

export async function inviteMember(email: string, role: MemberRole): Promise<PendingInvitation> {
  const res = await post("/api/auth/organization/invite-member", { email, role, resend: true }, "Could not send the invitation.");
  const body = (await res.json()) as { id: string; email: string; role: string | null; expiresAt: string };
  return { id: body.id, email: body.email, role: memberRole(body.role), expiresAt: body.expiresAt };
}

export async function cancelInvitation(invitationId: string): Promise<void> {
  await post("/api/auth/organization/cancel-invitation", { invitationId }, "Could not cancel the invitation.");
}

export async function updateMemberRole(memberId: string, role: MemberRole): Promise<void> {
  await post("/api/auth/organization/update-member-role", { memberId, role }, "Could not change the role.");
}

export async function removeMember(memberId: string): Promise<void> {
  await post("/api/auth/organization/remove-member", { memberIdOrEmail: memberId }, "Could not remove the member.");
}

/** The link an inviter can hand over when the deployment sends no mail. */
export function invitationHref(invitationId: string, origin: string): string {
  return new URL(`/accept-invitation/${encodeURIComponent(invitationId)}`, origin).toString();
}
