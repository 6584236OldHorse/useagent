import type { ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { LibrarySidebar } from "@/components/shell/library-sidebar";

/**
 * The persistent shell for the Customize pages (skills, knowledge, wiki, memory,
 * tasks, artifacts, playbooks, secrets, apps, reviews, learnings, automations,
 * plugins). It survives navigation between them, so a hop swaps only the page
 * area (the group's loading skeleton renders inside it). The rail derives its
 * active item from the pathname.
 */
export default function LibraryLayout({ children }: { children: ReactNode }) {
  return <AppShell sidebar={<LibrarySidebar />}>{children}</AppShell>;
}
