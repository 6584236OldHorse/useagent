import { describe, expect, test } from "bun:test";
import { ClerkProvider } from "@clerk/nextjs";
import { RiBook3Line } from "@remixicon/react";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarProvider } from "@/components/sidebar-kit/sidebar";
import { TooltipProvider } from "@/components/sidebar-kit/tooltip";
import { legacyAuthEnabled } from "@/lib/auth-mode";
import { AppShell } from "./app-shell";
import { AppSidebarFrame, NavRoutes } from "./app-sidebar-frame";
import { SidebarThreadsProvider } from "./sidebar-threads-provider";
import { ThreadSidebar } from "./thread-sidebar";
import { managedUserProfile } from "./user-menu";

const router = {
  push() {},
  replace() {},
  refresh() {},
  back() {},
  forward() {},
  prefetch() {},
} as unknown as AppRouterInstance;

const TEST_PUBLISHABLE_KEY = "pk_test_Y2xlcmsudGVzdCQ";

function renderSidebar(node: ReactNode, defaultOpen = false): string {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <ClerkProvider publishableKey={TEST_PUBLISHABLE_KEY}>
        <PathnameContext.Provider value="/artifacts">
          <TooltipProvider>
            <SidebarThreadsProvider>
              <SidebarProvider defaultOpen={defaultOpen}>{node}</SidebarProvider>
            </SidebarThreadsProvider>
          </TooltipProvider>
        </PathnameContext.Provider>
      </ClerkProvider>
    </AppRouterContext.Provider>,
  );
}

const renderCollapsed = (node: ReactNode) => renderSidebar(node);

describe("collapsed application sidebar", () => {
  test("keeps real search mounted and grouped routes labelled and navigable", () => {
    const routes = [
      {
        id: "library",
        title: "Library",
        icon: RiBook3Line,
        href: "/artifacts",
        active: true,
        subs: [{ title: "Artifacts", href: "/artifacts", icon: RiBook3Line }],
      },
    ];
    const navHtml = renderCollapsed(<NavRoutes routes={routes} />);
    expect(navHtml).toContain('href="/artifacts"');
    expect(navHtml).toContain('aria-label="Library"');
    expect(navHtml).toContain('aria-current="page"');
    const frameHtml = renderCollapsed(<AppSidebarFrame>Navigation</AppSidebarFrame>);
    expect(frameHtml).toContain('aria-label="Search"');
    expect(frameHtml).toContain('aria-label="Open account menu"');
  });

  test("does not advertise Bots before the capability catalog loads", () => {
    expect(renderCollapsed(<ThreadSidebar active="bots" />)).not.toContain('href="/bots"');
  });

  test("uses one main landmark for the bounded page scroll area", () => {
    const html = renderCollapsed(<AppShell sidebar={<aside>Navigation</aside>}>Page</AppShell>);
    expect(html.match(/<main(?:\s|>)/g)).toHaveLength(1);
    expect(html).toContain('<div data-slot="sidebar-inset"');
    expect(html).toContain('<main id="main-content"');
  });

  test("uses provider identity for the menu and footer even when workspace access is unavailable", () => {
    expect(
      managedUserProfile({
        isLoaded: true,
        isSignedIn: true,
        user: {
          fullName: "Abhishek Agarwal",
          primaryEmailAddress: { emailAddress: "abhishek@example.com" },
          imageUrl: "https://img.example/avatar.png",
        },
      }),
    ).toEqual({
      name: "Abhishek Agarwal",
      email: "abhishek@example.com",
      image: "https://img.example/avatar.png",
      loaded: true,
      signedIn: true,
    });

    const loadingHtml = renderSidebar(<AppSidebarFrame>Navigation</AppSidebarFrame>, true);
    if (legacyAuthEnabled) {
      expect(loadingHtml).toContain("Guest");
      expect(loadingHtml).toContain("Not signed in");
    } else {
      expect(loadingHtml).toContain("Account");
      expect(loadingHtml).toContain("Loading account...");
      expect(loadingHtml).not.toContain("Guest");
    }
  });
});
