"use client";

import { OrganizationSwitcher, useAuth } from "@clerk/nextjs";
import { RiApps2Line, RiLoginBoxLine, RiLogoutBoxRLine, RiSettings3Line } from "@remixicon/react";
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
 * base dropdown menu - identity header, Settings / Apps, sign-in/out. Identity is
 * the backend-normalized session from lib/auth.ts. Theme switching lives in
 * the shell ThemeMenu, not here.
 */
interface UserMenuProps {
  /** A custom trigger (the sidebar footer card) instead of the bare avatar. */
  trigger?: ReactNode;
}

export function UserMenu(props: UserMenuProps = {}) {
  return legacyAuthEnabled ? <UserMenuView {...props} /> : <ManagedUserMenu {...props} />;
}

function ManagedUserMenu({ trigger }: UserMenuProps) {
  const { isLoaded, signOut: endSession, userId } = useAuth();
  return (
    <UserMenuView
      trigger={trigger}
      providerLoaded={isLoaded}
      providerUserId={userId}
      onSignOut={async () => {
        await endSession();
        invalidateSession();
      }}
    />
  );
}

function UserMenuView({
  trigger,
  providerLoaded,
  providerUserId,
  onSignOut = signOut,
}: UserMenuProps & {
  providerLoaded?: boolean;
  providerUserId?: string | null;
  onSignOut?: () => Promise<void>;
}) {
  const router = useRouter();
  const { session } = useSession();
  const [open, setOpen] = useState(false);
  const managed = providerLoaded !== undefined;
  const signedIn = managed ? providerLoaded && Boolean(providerUserId) : session !== null;
  const showSignOut = managed ? !providerLoaded || signedIn : signedIn;
  const signOutDisabled = managed && (!providerLoaded || !signedIn);

  const name =
    session?.user.name?.trim() || session?.user.email || (showSignOut ? "Account" : "Guest");
  const email =
    session?.user.email ?? (showSignOut ? "Workspace session unavailable" : "Not signed in");
  const image = session?.user.image ?? null;
  const initial = (name.charAt(0) || "?").toUpperCase();

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
          trigger ? "w-full rounded-lg text-left" : "rounded-full focus-visible:ring-offset-2"
        }
      >
        {trigger ?? (
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
            {managed && signedIn ? (
              <OrganizationSwitcher
                appearance={{
                  elements: {
                    rootBox: "w-full px-2 pb-1.5",
                    organizationSwitcherTrigger:
                      "w-full rounded-lg border border-border-button-default bg-background-tertiary-default",
                  },
                }}
                hidePersonal
              />
            ) : null}
            <DropdownDivider />
          </>
        }
      >
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
