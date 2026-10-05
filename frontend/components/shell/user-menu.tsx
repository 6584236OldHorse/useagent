"use client";

import { useAuth, useOrganizationList, useUser } from "@clerk/nextjs";
import {
  RiApps2Line,
  RiBuilding4Line,
  RiCheckLine,
  RiLoginBoxLine,
  RiLogoutBoxRLine,
  RiSettings3Line,
} from "@remixicon/react";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { Avatar } from "@/components/base/avatar/avatar";
import { Badge } from "@/components/base/badges/badge";
import {
  Dropdown,
  DropdownDivider,
  DropdownMenu,
  DropdownMenuItem,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";
import { invalidateSession, signOut, useSession } from "@/lib/auth";
import { legacyAuthEnabled } from "@/lib/auth-mode";

/**
 * Account affordance in the sidebar clusters: an avatar that opens a BoardUI
 * base dropdown menu - identity header, workspace picker, Settings / Apps,
 * sign-in/out. Managed identity comes directly from the provider; legacy auth
 * keeps using the backend-normalized session. Theme switching lives in the
 * shell ThemeMenu, not here.
 */
export interface UserMenuProfile {
  readonly name: string;
  readonly email: string;
  readonly image: string | null;
  readonly loaded: boolean;
  readonly signedIn: boolean;
}

interface UserMenuProps {
  /** A custom trigger (the sidebar footer card) instead of the bare avatar. */
  trigger?: ReactNode | ((profile: UserMenuProfile) => ReactNode);
}

export function UserMenu(props: UserMenuProps = {}) {
  return legacyAuthEnabled ? <LegacyUserMenu {...props} /> : <ManagedUserMenu {...props} />;
}

function ManagedUserMenu({ trigger }: UserMenuProps) {
  const { isLoaded: authLoaded, orgId, signOut: endSession } = useAuth();
  const { isLoaded: userLoaded, isSignedIn, user } = useUser();
  const { loading: workspaceLoading, session: workspaceSession } = useSession();
  const organizations = useOrganizationList({ userMemberships: { pageSize: 100 } });
  const [workspaceSwitchError, setWorkspaceSwitchError] = useState<string | null>(null);
  const profile = managedUserProfile({
    isLoaded: authLoaded && userLoaded,
    isSignedIn,
    user,
  });
  const workspaces = (organizations.userMemberships.data ?? [])
    .map((membership) => ({
      id: membership.organization.id,
      name: membership.organization.name,
      active: membership.organization.id === orgId,
    }))
    .sort(
      (left, right) =>
        Number(right.active) - Number(left.active) || left.name.localeCompare(right.name),
    );
  return (
    <UserMenuView
      trigger={trigger}
      profile={profile}
      workspaces={profile.signedIn ? workspaces : undefined}
      workspacesLoaded={organizations.isLoaded}
      workspaceAccessError={
        workspaceSwitchError ??
        (organizations.userMemberships.isError
          ? "Could not load workspaces"
          : profile.signedIn && !workspaceLoading && !workspaceSession
            ? "Workspace access unavailable"
            : null)
      }
      onSelectWorkspace={async (organization) => {
        if (!organizations.setActive || organization === orgId) return;
        setWorkspaceSwitchError(null);
        try {
          await organizations.setActive({ organization });
          invalidateSession();
        } catch {
          setWorkspaceSwitchError("Could not switch workspace");
        }
      }}
      onSignOut={async () => {
        await endSession();
        invalidateSession();
      }}
    />
  );
}

export function managedUserProfile(input: {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean | undefined;
  readonly user:
    | {
        readonly fullName: string | null;
        readonly primaryEmailAddress: { readonly emailAddress: string } | null;
        readonly imageUrl: string;
      }
    | null
    | undefined;
}): UserMenuProfile {
  if (!input.isLoaded) {
    return {
      name: "Account",
      email: "Loading account...",
      image: null,
      loaded: false,
      signedIn: false,
    };
  }
  if (!input.isSignedIn || !input.user) {
    return { name: "Guest", email: "Not signed in", image: null, loaded: true, signedIn: false };
  }
  const email = input.user.primaryEmailAddress?.emailAddress ?? "Signed in";
  return {
    name: input.user.fullName?.trim() || email,
    email,
    image: input.user.imageUrl || null,
    loaded: true,
    signedIn: true,
  };
}

function LegacyUserMenu(props: UserMenuProps) {
  const { session } = useSession();
  const signedIn = session !== null;
  const email = session?.user.email ?? "Not signed in";
  return (
    <UserMenuView
      {...props}
      profile={{
        name: session?.user.name?.trim() || session?.user.email || "Guest",
        email,
        image: session?.user.image ?? null,
        loaded: true,
        signedIn,
      }}
    />
  );
}

function UserMenuView({
  trigger,
  profile,
  workspaces,
  workspacesLoaded = true,
  workspaceAccessError,
  onSelectWorkspace,
  onSignOut = signOut,
}: UserMenuProps & {
  profile: UserMenuProfile;
  workspaces?: readonly { readonly id: string; readonly name: string; readonly active: boolean }[];
  workspacesLoaded?: boolean;
  workspaceAccessError?: string | null;
  onSelectWorkspace?: (organization: string) => Promise<void>;
  onSignOut?: () => Promise<void>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const showSignOut = !profile.loaded || profile.signedIn;
  const signOutDisabled = !profile.loaded || !profile.signedIn;
  const { name, email, image } = profile;
  const initial = (name.charAt(0) || "?").toUpperCase();
  const triggerNode = typeof trigger === "function" ? trigger(profile) : trigger;

  async function handleSignOut() {
    if (signOutDisabled) return;
    setOpen(false);
    await onSignOut();
    router.push("/login");
    router.refresh();
  }

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <Dropdown isOpen={open} onOpenChange={setOpen}>
      <DropdownTrigger
        aria-label="Open account menu"
        aria-haspopup="menu"
        className={
          triggerNode ? "w-full rounded-lg text-left" : "rounded-full focus-visible:ring-offset-2"
        }
      >
        {triggerNode ?? (
          <Avatar size="md" color="pink" src={image ?? undefined} alt={name} initials={initial} />
        )}
      </DropdownTrigger>

      <DropdownMenu
        aria-label="Account menu"
        placement="bottom end"
        className="w-72"
        header={
          <>
            <div className="flex items-center gap-3 px-2 py-1.5">
              <Avatar
                size="lg"
                color="pink"
                src={image ?? undefined}
                alt={name}
                initials={initial}
              />
              <div className="min-w-0">
                <p className="truncate text-body-2-medium text-text-primary">{name}</p>
                <p className="truncate text-caption-1-regular text-text-secondary">{email}</p>
              </div>
            </div>
            {workspaces ? (
              <div className="px-2 pt-1">
                <p className="text-caption-1-medium text-text-tertiary">Workspace</p>
                {workspaceAccessError ? (
                  <p className="text-caption-1-regular text-text-error-primary" role="alert">
                    {workspaceAccessError}
                  </p>
                ) : null}
              </div>
            ) : null}
            <DropdownDivider />
          </>
        }
      >
        {workspaces ? (
          workspacesLoaded && workspaces.length > 0 ? (
            workspaces.map((workspace) => (
              <DropdownMenuItem
                key={workspace.id}
                id={`workspace-${workspace.id}`}
                textValue={workspace.name}
                shouldCloseOnSelect={false}
                onAction={() => void onSelectWorkspace?.(workspace.id)}
              >
                <RiBuilding4Line
                  className="size-5 shrink-0 text-foreground-icon-secondary"
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-body-2-medium">{workspace.name}</span>
                {workspace.active ? (
                  <>
                    <RiCheckLine
                      className="size-4 shrink-0 text-foreground-icon-primary"
                      aria-hidden
                    />
                    <span className="sr-only">Selected</span>
                  </>
                ) : null}
              </DropdownMenuItem>
            ))
          ) : (
            <DropdownMenuItem id="workspace-status" textValue="Workspace status" isDisabled>
              <span className="text-caption-1-regular text-text-tertiary">
                {workspacesLoaded ? "No workspaces available" : "Loading workspaces..."}
              </span>
            </DropdownMenuItem>
          )
        ) : null}
        <DropdownMenuItem id="settings" textValue="Settings" onAction={() => go("/settings")}>
          <RiSettings3Line className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
          <span className="text-body-2-medium">Settings</span>
        </DropdownMenuItem>
        <DropdownMenuItem id="apps" textValue="Apps" onAction={() => go("/apps")}>
          <RiApps2Line className="size-5 shrink-0 text-foreground-icon-secondary" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-body-2-medium">Apps</span>
          <Badge className="bg-badge-new-background text-badge-new-text">New</Badge>
        </DropdownMenuItem>
        {showSignOut ? (
          <DropdownMenuItem
            id="sign-out"
            textValue="Log out"
            isDisabled={signOutDisabled}
            onAction={() => void handleSignOut()}
          >
            <RiLogoutBoxRLine
              className="size-5 shrink-0 text-foreground-icon-secondary"
              aria-hidden
            />
            <span className="text-body-2-medium">Log out</span>
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem id="sign-in" textValue="Sign in" onAction={() => go("/login")}>
            <RiLoginBoxLine
              className="size-5 shrink-0 text-foreground-icon-secondary"
              aria-hidden
            />
            <span className="text-body-2-medium">Sign in</span>
          </DropdownMenuItem>
        )}
      </DropdownMenu>
    </Dropdown>
  );
}
