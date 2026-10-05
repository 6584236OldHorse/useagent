import type { ReactNode } from "react";
import { ChatTabs } from "@/components/chat/chat-tabs";
import { AppShell } from "@/components/shell/app-shell";
import { ThreadSidebar } from "@/components/shell/thread-sidebar";

/**
 * The persistent shell for thread views. Living ABOVE the `[id]` segment, this
 * layout survives session-to-session navigation, so switching threads swaps
 * only the conversation area (the segment's loading skeleton renders inside
 * it) instead of unmounting the sidebar and flashing a full-viewport loader.
 * The chat tabs sit across the top of that area for the same reason: they
 * outlive any one session.
 */
export default function ThreadLayout({ children }: { children: ReactNode }) {
  return (
    <AppShell sidebar={<ThreadSidebar />} collapseSidebarAtTablet>
      <div className="flex h-full min-h-0 flex-col">
        <ChatTabs />
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </AppShell>
  );
}
