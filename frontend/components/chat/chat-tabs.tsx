"use client";

// Chat tabs across the top of the transcript: the chats opened in this
// browser, in the order they were opened, the current one selected. A tab is
// a link to its session; its x closes it, and closing the current one moves
// to its neighbour. Titles read from the rail's thread list; the list is
// remembered per user like the pins.

import { RiCloseLine } from "@remixicon/react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import { openTabs } from "@/components/chat/chat-tabs-store";
import { chatTitle } from "@/components/shell/chat-title";
import { useSidebarThreads } from "@/components/shell/sidebar-threads-provider";
import { useSession } from "@/lib/auth";
import { cx } from "@/utils/cx";

export interface ChatTab {
  readonly id: string;
  readonly title: string;
  readonly href: string;
}

/** The strip itself. Nothing renders until a chat is open. */
export function ChatTabStrip({
  tabs,
  activeId,
  onClose,
}: {
  tabs: readonly ChatTab[];
  activeId: string | null;
  onClose: (id: string) => void;
}) {
  if (tabs.length === 0) return null;
  return (
    <div
      role="tablist"
      aria-label="Open chats"
      data-testid="chat-tabs"
      className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b border-border-button-default/50 px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div
            key={tab.id}
            role="presentation"
            data-active={active ? "" : undefined}
            className={cx(
              "group flex h-8 max-w-56 shrink-0 items-center gap-1 rounded-t-lg border border-b-0 border-border-button-default/50 pl-3 pr-1 transition-colors",
              active
                ? "bg-background-primary-default text-text-primary"
                : "bg-background-secondary-default text-text-secondary hover:text-text-primary",
            )}
          >
            <Link
              role="tab"
              aria-selected={active}
              aria-current={active ? "page" : undefined}
              href={tab.href}
              title={tab.title}
              className="min-w-0 truncate rounded-sm text-body-2-medium outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              {tab.title}
            </Link>
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              onClick={() => onClose(tab.id)}
              className={cx(
                "flex size-5 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-opacity hover:bg-background-tertiary-hover hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring group-hover:opacity-100",
                active ? "opacity-100" : "opacity-0",
              )}
            >
              <RiCloseLine className="size-3.5" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function ChatTabs() {
  const params = useParams<{ id?: string }>();
  const currentId = typeof params?.id === "string" ? params.id : null;
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const ids = openTabs.useList(userId);
  const runs = useSidebarThreads();
  const router = useRouter();
  useEffect(() => {
    if (currentId) openTabs.add(userId, currentId);
  }, [currentId, userId]);
  const titles = new Map(runs.map((run) => [run.id, chatTitle(run.prompt)]));
  const tabs = ids.map((id) => ({ id, title: titles.get(id) ?? "Chat", href: `/session/${id}` }));
  return (
    <ChatTabStrip
      tabs={tabs}
      activeId={currentId}
      onClose={(id) => {
        const index = ids.indexOf(id);
        openTabs.remove(userId, id);
        if (id !== currentId) return;
        const next = ids[index + 1] ?? ids[index - 1];
        router.push(next ? `/session/${next}` : "/agent/new");
      }}
    />
  );
}
