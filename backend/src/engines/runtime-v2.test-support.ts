// Protocol 2 fixtures for the runtime driver's tests: projection records with
// the fields the runtime sends, and a scripted thread follower.
import type { FollowRuntimeThreadInput } from "./runtime-event-stream";
import { runtimeThreadView } from "./runtime-v2-view";
import type {
  V2Message,
  V2Projection,
  V2ProviderSession,
  V2ProviderThread,
  V2Run,
  V2RunStatus,
  V2ThreadSnapshot,
  V2TurnItem,
} from "./runtime-v2-wire";

export const T0 = "2026-10-03T00:00:00.000Z";
export const at = (seconds: number): string => new Date(Date.parse(T0) + seconds * 1000).toISOString();

export function v2Run(overrides: Partial<V2Run> & { readonly id: string }): V2Run {
  return {
    ordinal: 1,
    userMessageId: `skynet-message-${overrides.id}`,
    status: "completed" as V2RunStatus,
    providerThreadId: "pt-1",
    requestedAt: T0,
    startedAt: T0,
    completedAt: T0,
    threadId: "skynet-thread-thread-1",
    ...overrides,
  };
}

export function v2Message(overrides: Partial<V2Message> & { readonly id: string }): V2Message {
  return {
    runId: null,
    role: "assistant",
    text: "",
    streaming: false,
    createdAt: T0,
    updatedAt: T0,
    threadId: "skynet-thread-thread-1",
    attachments: [],
    ...overrides,
  };
}

export function v2Item(overrides: Partial<V2TurnItem> & { readonly id: string; readonly type: string }): V2TurnItem {
  return {
    threadId: "skynet-thread-thread-1",
    runId: null,
    status: "completed",
    title: null,
    updatedAt: T0,
    ordinal: 0,
    ...overrides,
  };
}

export function v2Session(overrides: Partial<V2ProviderSession> = {}): V2ProviderSession {
  return { id: "ps-1", status: "ready", lastError: null, driver: "opencode", providerInstanceId: "opencode", ...overrides };
}

export function v2ProviderThread(overrides: Partial<V2ProviderThread> = {}): V2ProviderThread {
  return { id: "pt-1", providerSessionId: "ps-1", appThreadId: "skynet-thread-thread-1", ...overrides };
}

export function v2Projection(overrides: Partial<V2Projection> = {}, threadId = "skynet-thread-thread-1"): V2Projection {
  return {
    thread: { id: threadId, runtimeMode: "full-access", activeProviderThreadId: "pt-1" },
    runs: [],
    messages: [],
    turnItems: [],
    providerSessions: [],
    providerThreads: [],
    runtimeRequests: [],
    subagents: [],
    ...overrides,
  };
}

export function v2Snapshot(snapshotSequence: number, projection: V2Projection = v2Projection()): V2ThreadSnapshot {
  return { snapshotSequence, projection };
}

/** A thread with one plane run in `status`, answered with `text`. */
export function v2Turn(input: {
  readonly sequence: number;
  readonly runId: string;
  readonly status: V2RunStatus;
  readonly text: string;
  readonly ordinal?: number;
  readonly threadId?: string;
}): V2ThreadSnapshot {
  const threadId = input.threadId ?? "skynet-thread-thread-1";
  return v2Snapshot(input.sequence, v2Projection({
    runs: [v2Run({ id: input.runId, status: input.status, ordinal: input.ordinal ?? 1, threadId, completedAt: input.status === "running" ? null : T0 })],
    messages: [
      v2Message({ id: `skynet-message-${input.runId}`, role: "user", runId: input.runId, text: "prompt", threadId }),
      v2Message({ id: `assistant-${input.runId}`, runId: input.runId, text: input.text, streaming: input.status === "running", threadId, createdAt: at(1) }),
    ],
  }, threadId));
}

/** A follower that runs `start` first, then hands each scripted state over in order, as the socket would. */
export function scriptedFollow(states: readonly V2ThreadSnapshot[], options: { readonly fail?: Error } = {}) {
  const calls: FollowRuntimeThreadInput[] = [];
  const follow = async (input: FollowRuntimeThreadInput): Promise<void> => {
    calls.push(input);
    await input.start?.();
    for (const state of states) {
      if (input.signal.aborted) return;
      input.onHeard?.();
      if (!(await input.applySnapshot(runtimeThreadView(state), state))) return;
    }
    if (options.fail) throw options.fail;
  };
  return { follow, calls };
}
