import { Suspense, type ReactNode } from "react";
import { loadBots } from "@/components/bots/load";
import { AppShell } from "@/components/shell/app-shell";
import { BotsPanel } from "@/components/shell/bots-panel";
import { ThreadSidebar } from "@/components/shell/thread-sidebar";

/** The roster column, streamed in once the backend answers. */
async function BotsRoster() {
  let initialBots = null;
  let initialError = false;
  try {
    initialBots = await loadBots();
    initialError = initialBots === null;
  } catch {
    initialError = true;
  }
  return <BotsPanel initialBots={initialBots} initialError={initialError} />;
}

/** Roster-width placeholder so the shell lays out before the roster streams in. */
function BotsRosterLoading() {
  return (
    <div
      className="hidden w-80 shrink-0 border-e border-border-button-white motion-safe:animate-pulse md:flex"
      role="status"
      aria-label="Loading bots"
    />
  );
}

/**
 * The persistent shell for the bots pages. The shell returns immediately; the
 * roster streams in under Suspense, so a hop into bots shows chrome first and
 * never waits on the roster request before painting.
 */
export default function BotsLayout({ children }: { children: ReactNode }) {
  return (
    <AppShell
      sidebar={<ThreadSidebar active="bots" />}
      panel={
        <Suspense fallback={<BotsRosterLoading />}>
          <BotsRoster />
        </Suspense>
      }
      collapseSidebarAtTablet
    >
      {children}
    </AppShell>
  );
}
