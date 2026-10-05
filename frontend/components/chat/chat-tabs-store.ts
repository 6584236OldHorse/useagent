"use client";

// The chats open as tabs over the transcript, in the order they were opened,
// per user in this browser. Twelve at most: the oldest tab closes itself when
// a thirteenth opens, so the strip never outgrows a scroll.

import { createLocalListStore } from "@/components/shell/local-list-store";

export const openTabs = createLocalListStore("useagent.session.tabs", 12);
