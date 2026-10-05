import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { ThreadSidebar } from "@/components/shell/thread-sidebar";

/**
 * The persistent shell for the thread-rail pages (dashboard, new thread, all
 * threads, settings). Living above the page segments, it survives navigation
 * between them, so a hop swaps only the page area (the group's loading
 * skeleton renders inside it) instead of remounting the sidebar and chrome.
 * The rail derives its active item from the pathname.
 */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return <AppShell sidebar={<ThreadSidebar />}>{children}</AppShell>;
}
