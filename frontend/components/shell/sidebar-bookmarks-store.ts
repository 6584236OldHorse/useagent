"use client";

// The chats pinned to the rail's Bookmarks, per user in this browser (the
// event log carries no pin), and the drag payload type a rail row carries so
// only a chat can be dropped there.

import { createLocalListStore } from "@/components/shell/local-list-store";

export const THREAD_DRAG_TYPE = "application/x-useagent-thread";

export const bookmarks = createLocalListStore("useagent.sidebar.bookmarks");
