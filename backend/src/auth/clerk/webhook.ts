import { verifyWebhook } from "@clerk/backend/webhooks";
import { identityDirectory, identityNotFound, type IdentityDirectory } from "./directory";
import {
  canCreateIdentityUser,
  IdentityAccessError,
  pruneIdentityMemberships,
  removeIdentityMembership,
  syncIdentityMembership,
  syncIdentityOrganization,
  syncIdentityUser,
  unlinkIdentityOrganization,
  unlinkIdentityUser,
  withIdentitySync,
} from "./store";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid identity event");
  return value as Record<string, unknown>;
}

function id(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255)
    throw new Error("Invalid identity id");
  return value;
}

/** Verified deliveries are notifications to read current state, not ordered commands. */
export async function synchronizeIdentityEvent(
  event: unknown,
  directory: IdentityDirectory = identityDirectory,
): Promise<void> {
  const envelope = object(event);
  const type =
    typeof envelope.type === "string"
      ? envelope.type.replace(/^organization_membership\./, "organizationMembership.")
      : "";
  if (!/^(?:user|organization|organizationMembership)\.(?:created|updated|deleted)$/.test(type))
    return;
  const data = object(envelope.data);
  const subject = id(data.id);
  await withIdentitySync(async (tx) => {
    if (type.startsWith("user.")) {
      let profile: Awaited<ReturnType<IdentityDirectory["user"]>>;
      try {
        profile = await directory.user(subject);
      } catch (error) {
        if (!identityNotFound(error)) throw error;
        await unlinkIdentityUser(subject, tx);
        return;
      }
      if (!profile.active) {
        await unlinkIdentityUser(subject, tx);
        return;
      }
      const memberships = await directory.memberships(subject);
      const result = await syncIdentityUser(
        profile,
        await canCreateIdentityUser(profile, memberships, tx),
        tx,
      );
      for (const item of memberships) {
        if (item.userId !== subject) throw new Error("Managed membership identity mismatch");
        await syncIdentityOrganization(item.organization, tx);
        await syncIdentityMembership(result.user.id, item, tx);
      }
      await pruneIdentityMemberships(
        result.user.id,
        new Set(memberships.map((item) => item.organization.id)),
        tx,
      );
      return;
    }
    if (type.startsWith("organization.")) {
      try {
        await syncIdentityOrganization(await directory.organization(subject), tx);
      } catch (error) {
        if (!identityNotFound(error)) throw error;
        await unlinkIdentityOrganization(subject, tx);
      }
      return;
    }
    const orgId = id(object(data.organization).id);
    const userId = id(object(data.public_user_data).user_id);
    let current: Awaited<ReturnType<IdentityDirectory["membership"]>>;
    try {
      current = await directory.membership(orgId, userId);
    } catch (error) {
      if (!identityNotFound(error)) throw error;
      current = null;
    }
    if (!current) {
      await removeIdentityMembership(orgId, userId, tx);
      return;
    }
    if (current.userId !== userId || current.organization.id !== orgId)
      throw new Error("Managed membership identity mismatch");
    const profile = await directory.user(userId);
    const result = await syncIdentityUser(
      profile,
      await canCreateIdentityUser(profile, [current], tx),
      tx,
    );
    await syncIdentityOrganization(current.organization, tx);
    await syncIdentityMembership(result.user.id, current, tx);
  });
}

export async function handleIdentityWebhook(request: Request): Promise<Response> {
  if (process.env.AUTH === "better-auth")
    return Response.json({ error: "identity_sync_paused" }, { status: 503 });
  const signingSecret = process.env.CLERK_WEBHOOK_SECRET;
  if (!signingSecret)
    return Response.json({ error: "identity_webhook_not_configured" }, { status: 503 });
  let event: Awaited<ReturnType<typeof verifyWebhook>>;
  try {
    event = await verifyWebhook(request, { signingSecret });
  } catch {
    return Response.json({ error: "invalid_webhook_signature" }, { status: 400 });
  }
  try {
    await synchronizeIdentityEvent(event);
    return Response.json({ received: true });
  } catch (error) {
    if (error instanceof IdentityAccessError)
      return Response.json({ received: true, admitted: false });
    // No payload, identity values, or credentials are logged on a retryable failure.
    return Response.json({ error: "identity_sync_failed" }, { status: 503 });
  }
}
