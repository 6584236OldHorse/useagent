"use client";

// The rail's Bookmarks: the chats the person pinned, one row each, above the
// projects. Drop a rail row here to pin it (the rows are draggable and carry
// a pin button), unpin with the x; empty, it says where the pins come from.
// Per user, in this browser.

import { RiBookmarkLine, RiCloseLine } from "@remixicon/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type DragEvent, useState } from "react";

/** Pinned rows shown before the "Show N more" fold. */
const VISIBLE_BOOKMARKS = 24;
import { chatTitle } from "@/components/shell/chat-title";
import { bookmarks, THREAD_DRAG_TYPE } from "@/components/shell/sidebar-bookmarks-store";
import { useSidebarThreads } from "@/components/shell/sidebar-threads-provider";
import { useSession } from "@/lib/auth";
import { cx } from "@/utils/cx";

export interface BookmarkRow {
  readonly id: string;
  readonly title: string;
  readonly href: string;
}

/** The section itself: rows, the drop target, the empty line. */
export function BookmarksSection({
  rows,
  activeHref,
  onPin,
  onUnpin,
}: {
  rows: readonly BookmarkRow[];
  activeHref: string | null;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
}) {
  const [over, setOver] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? rows : rows.slice(0, VISIBLE_BOOKMARKS);
  const hidden = rows.length - shown.length;
  const carriesChat = (event: DragEvent) => event.dataTransfer.types.includes(THREAD_DRAG_TYPE);
  return (
    <section
      aria-label="Bookmarks"
      data-testid="sidebar-bookmarks"
      data-drop-target={over ? "" : undefined}
      onDragOver={(event) => {
        if (!carriesChat(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        if (!carriesChat(event)) return;
        event.preventDefault();
        setOver(false);
        const id = event.dataTransfer.getData(THREAD_DRAG_TYPE);
        if (id) onPin(id);
      }}
      className={cx(
        "rounded-lg transition-colors",
        over && "bg-background-secondary-hover ring-1 ring-inset ring-border-focus-ring",
      )}
    >
      <p className="text-mono-label px-2.5 pb-1 pt-3 text-text-tertiary">Bookmarks</p>
      {rows.length === 0 ? (
        <p className="px-2.5 pb-2 text-caption-1-regular text-text-tertiary">
          Drag chats here to pin them
        </p>
      ) : (
        <ul className="flex flex-col">
          {shown.map((row) => {
            const active = row.href === activeHref;
            return (
              <li
                key={row.id}
                data-session-ui="bookmark-row"
                className={cx(
                  "group flex h-8 items-center gap-2 rounded-2lg pl-2.5 pr-1 transition-colors duration-150 ease",
                  active
                    ? "bg-background-secondary-hover text-text-primary"
                    : "hover:bg-background-secondary-hover",
                )}
              >
                <RiBookmarkLine
                  className="size-4 shrink-0 text-foreground-icon-tertiary"
                  aria-hidden
                />
                <Link
                  href={row.href}
                  aria-current={active ? "page" : undefined}
                  title={row.title}
                  className={cx(
                    "min-w-0 flex-1 truncate text-body-2-medium",
                    active ? "text-text-primary" : "text-text-secondary",
                  )}
                >
                  {row.title}
                </Link>
                <button
                  type="button"
                  aria-label={`Unpin ${row.title}`}
                  onClick={() => onUnpin(row.id)}
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-text-tertiary opacity-0 transition-opacity hover:bg-background-tertiary-hover hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring group-hover:opacity-100"
                >
                  <RiCloseLine className="size-3.5" aria-hidden />
                </button>
              </li>
            );
          })}
          {(hidden > 0 || showAll) && (
            <li>
              <button
                type="button"
                onClick={() => setShowAll((value) => !value)}
                className="flex w-full items-center gap-1 rounded-lg px-2.5 py-1 text-caption-1-regular text-text-secondary transition-colors hover:bg-background-secondary-hover hover:text-text-primary"
              >
                {showAll ? "Show fewer" : `Show ${hidden} more`}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

export function SidebarBookmarks() {
  const { session } = useSession();
  const userId = session?.user.id ?? null;
  const pinned = bookmarks.useList(userId);
  const runs = useSidebarThreads();
  const pathname = usePathname();
  const titles = new Map(runs.map((run) => [run.id, chatTitle(run.prompt)]));
  const rows = pinned.map((id) => ({
    id,
    // A pin older than the rail's window still opens; it just has no title here.
    title: titles.get(id) ?? "Pinned chat",
    href: `/session/${id}`,
  }));
  return (
    <BookmarksSection
      rows={rows}
      activeHref={pathname}
      onPin={(id) => bookmarks.add(userId, id)}
      onUnpin={(id) => bookmarks.remove(userId, id)}
    />
  );
}
