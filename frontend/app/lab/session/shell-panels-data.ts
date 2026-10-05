// Fixtures for the /lab/session shell panels (the chat tabs, the Bookmarks
// with its draggable rows, the Details rail), built on the same synthetic
// conversation as the rest of the sample. NOT vendored, NOT product data.

import type { ChatTab } from "@/components/chat/chat-tabs";
import type { NativeFrame } from "@/components/chat/native-events";
import type { PlanTurn } from "@/components/chat/thread-plan";
import type { UsageTurn } from "@/components/chat/thread-usage";
import type { ApiRun } from "@/components/chat/types";
import type { ProjectThread } from "@/components/session-ui/project-thread-tree";
import { chatTitle } from "@/components/shell/chat-title";
import type { BookmarkRow } from "@/components/shell/sidebar-bookmarks";
import { conversation, planTodoStep } from "./session-sample-data";

/** The thread's root run as the wire carries it: the repositories and the
 *  branch the rail's Environment reads, the engine and model of its runtime. */
export const sampleRun = {
  id: "turn-1",
  org_id: null,
  user_id: null,
  prompt: conversation[0].prompt,
  model: "claude-sonnet-5",
  engine: "opencode",
  status: "completed",
  summary: conversation[0].answer ?? null,
  duration_ms: 48_000,
  parent_run_id: null,
  child_session: false,
  thread_id: "turn-1",
  engine_session_id: "ses_root",
  sandbox_id: null,
  repo: "useagent/gateway",
  repos: ["useagent/gateway"],
  repo_specs: [{ repo: "useagent/gateway", branch: "rl-staging" }],
  resolved_resources: [],
  memory_scope: "org",
  skill_id: null,
  skill_version: null,
  skill_content_hash: null,
  uploads: [],
  created_at: "2026-08-17T09:00:00.000Z",
  updated_at: "2026-08-17T09:00:48.000Z",
  steps: [],
} as ApiRun;

/** Two model calls' step-finish frames, the shape the context ring reads. */
function usageFrame(id: string, seq: number, tokens: Record<string, unknown>): NativeFrame {
  return {
    schemaVersion: 1,
    eventId: id,
    seq,
    provider: "opencode",
    eventType: "part.step-finish",
    native: { sessionId: "ses_root", parentSessionId: null, messageId: null, partId: null, callId: null },
    payload: { tokens, contextWindow: 200_000 },
  };
}

/** The thread as the Details rail sees it: turn-1's tool steps and its plan,
 *  with the tokens its two model calls reported. */
export const detailsTurns: readonly (PlanTurn & UsageTurn)[] = [
  {
    run: sampleRun,
    status: "completed",
    steps: [
      ...conversation[0].nodes.flatMap((node) => (node.kind === "tool" ? [node.step] : [])),
      planTodoStep,
    ],
    canonical: [],
    native: {
      nativeFrames: [
        usageFrame("u1", 1, { input: 9_840, output: 612, cache: { read: 2_400, write: 180 } }),
        usageFrame("u2", 2, { input: 1_120, output: 1_306, cache: { read: 12_400, write: 0 } }),
      ],
      childSessionIds: new Set<string>(),
    },
  },
];

/** The chats open as tabs: the conversation's turns, titled the way the rail titles them. */
export const sampleTabs: readonly ChatTab[] = conversation
  .slice(0, 3)
  .map((turn) => ({ id: turn.id, title: chatTitle(turn.prompt), href: `#${turn.id}` }));

export const sampleBookmarks: readonly BookmarkRow[] = [
  { id: "turn-1", title: chatTitle(conversation[0].prompt), href: "#turn-1" },
];

/** The conversation's turns as rail rows: the titles the rail derives, a
 *  relative time each, and the status that decides the tick or the dot. */
export const sampleThreads: readonly ProjectThread[] = conversation.map((turn, index) => ({
  id: turn.id,
  label: chatTitle(turn.prompt),
  time: ["2h", "1h", "now", "now"][index] ?? "now",
  status: turn.status,
}));
