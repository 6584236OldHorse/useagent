import type { Organization, OrganizationMembership } from "@clerk/backend";
import { identityClient } from "./client";

export interface IdentityProfile {
  id: string;
  email: string | null;
  name: string;
  image: string | null;
  active: boolean;
  updatedAt: number;
}

export interface IdentityOrganization {
  id: string;
  name: string;
  slug: string;
  image: string | null;
  createdAt: number;
  createdBy: string | null;
}

export interface IdentityMembership {
  userId: string;
  organization: IdentityOrganization;
  role: string;
}

function organization(value: Organization): IdentityOrganization {
  return {
    id: value.id,
    name: value.name,
    slug: value.slug || value.id,
    image: value.hasImage ? value.imageUrl : null,
    createdAt: value.createdAt,
    createdBy: value.createdBy ?? null,
  };
}

function membership(value: OrganizationMembership): IdentityMembership {
  const userId = value.publicUserData?.userId;
  if (!userId) throw new Error("Managed membership has no user");
  return { userId, organization: organization(value.organization), role: value.role };
}

export function identityNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

/** These reads never trust email, role, or profile claims supplied by a renderer. */
export const identityDirectory = {
  async user(id: string): Promise<IdentityProfile> {
    const value = await identityClient().users.getUser(id);
    if (value.id !== id) throw new Error("Managed user identity mismatch");
    const primary = value.emailAddresses.find((email) => email.id === value.primaryEmailAddressId);
    const email = primary?.verification?.status === "verified" ? primary.emailAddress.trim() : null;
    return {
      id,
      email,
      name:
        [value.firstName, value.lastName].filter(Boolean).join(" ").trim() ||
        value.username ||
        "User",
      image: value.hasImage ? value.imageUrl : null,
      active: !value.banned && !value.locked,
      updatedAt: value.updatedAt,
    };
  },
  async organization(id: string): Promise<IdentityOrganization> {
    const value = await identityClient().organizations.getOrganization({ organizationId: id });
    if (value.id !== id) throw new Error("Managed organization identity mismatch");
    return organization(value);
  },
  async memberships(userId: string): Promise<IdentityMembership[]> {
    const client = identityClient();
    const result: IdentityMembership[] = [];
    for (let offset = 0; ; offset += 100) {
      const page = await client.users.getOrganizationMembershipList({ userId, offset, limit: 100 });
      for (const value of page.data) {
        const item = membership(value);
        if (item.userId !== userId) throw new Error("Managed membership identity mismatch");
        result.push(item);
      }
      if (offset + page.data.length >= page.totalCount) return result;
      if (page.data.length === 0) throw new Error("Managed membership list is incomplete");
    }
  },
  async membership(organizationId: string, userId: string): Promise<IdentityMembership | null> {
    const page = await identityClient().organizations.getOrganizationMembershipList({
      organizationId,
      userId: [userId],
      limit: 2,
    });
    if (page.totalCount > 1) throw new Error("Managed membership is ambiguous");
    const value = page.data[0];
    if (!value) return null;
    const item = membership(value);
    if (item.userId !== userId || item.organization.id !== organizationId)
      throw new Error("Managed membership identity mismatch");
    return item;
  },
};

export type IdentityDirectory = typeof identityDirectory;
