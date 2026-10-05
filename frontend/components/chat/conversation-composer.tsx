"use client";

import type { ThreadRelationship } from "@useagent/agent-client";
import { useMemo, useRef, useState } from "react";
import type { PendingApproval } from "@/components/chat/approval-state";
import type { CommandCatalogState } from "@/components/chat/canonical-timeline";
import type { ComposerSubmit } from "@/components/chat/composer";
import type { AssistantIdentity, Turn } from "@/components/chat/conversation";
import { toGatewayChildSession } from "@/components/chat/gateway-children";
import { latestThreadContext } from "@/components/chat/native-events";
import {
  composerAcceptsRunResources,
  type PendingQuestion,
} from "@/components/chat/question-state";
import { ReplyComposer } from "@/components/chat/reply-composer";
import type { SlashCommand } from "@/components/chat/slash-command";
import { cleanPrompt, type EngineId, type MemoryScope, modelLabel } from "@/components/chat/types";
import { ComposerStatusBar } from "@/components/pro/composer-status-bar";
import { type QueuedMessage, QueuedMessages } from "@/components/pro/queued-messages";
import { RunningFooter } from "@/components/pro/running-footer";
import {
  advanceLiveGrowth,
  deriveRunningChildren,
  deriveRunningStatus,
  NO_GROWTH,
} from "@/components/pro/running-phase";
import { engineDisplayLabel } from "@/components/session-ui/provider-status-banner";

/**
 * The reply composer of a thread plus everything that frames it: the running
 * footer while a turn runs (phase, current step, elapsed, Stop), the messages
 * still waiting in the queue as numbered rows, the placeholder for the thread's
 * state, the status bar (branch, project, engine, context meter) and the
 * Compact now action, which is offered only while nothing is pending, queued or
 * running, and whose refusal shows in the same banner a failed turn uses.
 * Dismissing the banner clears only the error it is showing.
 */
export function ConversationComposer({
  turns,
  defaultEngine,
  defaultModel,
  defaultMemoryScope,
  pendingReply,
  commands,
  commandState,
  modelSelection,
  controlLocksComposer,
  composerLocked,
  composerLockedMessage,
  pendingApproval,
  pendingQuestion,
  composerCanAnswerQuestion,
  assistantIdentity,
  onReply,
  running,
  stopping,
  stopError,
  onStop,
  runStartedAt,
  sendNowFor,
  onSendNow,
  onRemoveQueued,
  productChildren,
  threadError,
  onDismissThreadError,
  handoffNotice,
  onDismissHandoffNotice,
  engineUnavailable,
  engineUnavailableMessage,
  prefill,
  resourceMentions,
  repoRevisions,
}: {
  turns: readonly Turn[];
  defaultEngine: EngineId;
  defaultModel: string;
  defaultMemoryScope: MemoryScope;
  pendingReply: string | null;
  commands?: SlashCommand[];
  commandState?: CommandCatalogState;
  modelSelection?: boolean;
  controlLocksComposer?: boolean;
  composerLocked?: boolean;
  composerLockedMessage?: string;
  pendingApproval?: PendingApproval | null;
  pendingQuestion?: PendingQuestion | null;
  composerCanAnswerQuestion?: boolean;
  assistantIdentity?: AssistantIdentity;
  onReply: ComposerSubmit;
  running?: boolean;
  stopping?: boolean;
  stopError?: string | null;
  onStop?: () => void;
  runStartedAt?: string | null;
  /** Run id of the HEAD queued turn while a turn runs: that row gets "Send now". */
  sendNowFor?: string | null;
  onSendNow?: () => void;
  /** Cancels a queued run before it starts (the durable cancel); rejects on failure. */
  onRemoveQueued?: (runId: string) => Promise<void> | void;
  /** Durable product children of the thread, for the running turn's delegation state. */
  productChildren?: readonly ThreadRelationship[];
  threadError: string | null;
  onDismissThreadError: () => void;
  handoffNotice?: string | null;
  onDismissHandoffNotice?: () => void;
  engineUnavailable?: boolean;
  engineUnavailableMessage?: string;
  prefill?: { readonly text: string; readonly nonce: number } | null;
  resourceMentions?: boolean;
  repoRevisions?: Readonly<Record<string, string | null>>;
}) {
  const context = useMemo(() => latestThreadContext(turns), [turns]);
  const [compactFailure, setCompactFailure] = useState<string | null>(null);
  // Turns the agent has not started: rows above the input, never transcript
  // bubbles. Positions count the WHOLE serial queue (a queued gateway child
  // ahead of a reply is real wait); the rows show the person's own messages.
  const queued = useMemo<QueuedMessage[]>(() => {
    const waiting = turns.filter((turn) => turn.status === "queued");
    const rows = waiting.flatMap((turn, index): QueuedMessage[] =>
      turn.run.child_session ? [] : [{ id: turn.run.id, position: index + 1, text: cleanPrompt(turn.run.prompt) }],
    );
    if (pendingReply !== null) {
      rows.push({ id: "pending", position: waiting.length + 1, text: pendingReply, pending: true });
    }
    return rows;
  }, [turns, pendingReply]);
  const runningTurn = running ? (turns.find((turn) => turn.status === "running") ?? null) : null;
  const runId = runningTurn?.run.id ?? null;
  // The running turn's gateway child sessions, identity-stable while their state holds.
  const childTurns = turns.filter((t) => t.run.child_session === true && t.run.parent_run_id === runId);
  const childSignature = childTurns.map((t) => `${t.run.id}:${t.status}:${t.summary ? 1 : 0}`).join("|");
  // The signature names every input that matters, so the list only changes with it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const childSessions = useMemo(() => childTurns.map(toGatewayChildSession), [childSignature]);
  const ownChildren = useMemo(
    () => productChildren?.filter((child) => child.sourceRunId === runId) ?? [],
    [productChildren, runId],
  );
  // Structural: recomputed when a step or a frame lands, not on a text delta.
  const steps = runningTurn?.steps;
  const frames = runningTurn?.native?.nativeFrames;
  const canonical = runningTurn?.canonical;
  const executionSummary = runningTurn?.executionSummary;
  const children = useMemo(
    () => (runningTurn ? deriveRunningChildren(runningTurn, childSessions, ownChildren) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runId, steps, frames, canonical, executionSummary, childSessions, ownChildren],
  );
  // Which live channel grew last decides writing versus thinking (a delta carries no seq).
  const growth = useRef(NO_GROWTH);
  if (runningTurn) growth.current = advanceLiveGrowth(growth.current, runningTurn.run.id, runningTurn);
  const runningStatus =
    runningTurn && children ? deriveRunningStatus(runningTurn, children, growth.current.latest) : null;
  const canCompact =
    !running &&
    pendingReply === null &&
    queued.length === 0 &&
    !pendingQuestion &&
    !pendingApproval &&
    !controlLocksComposer &&
    !composerLocked &&
    (commands?.some((c) => c.name === "compact") ?? false);
  const compact = () => {
    setCompactFailure(null);
    Promise.resolve(
      onReply("/compact", defaultEngine, defaultModel, crypto.randomUUID(), defaultMemoryScope, {
        name: "compact",
        args: "",
      }),
    ).catch((error: unknown) => {
      setCompactFailure(
        error instanceof Error && error.message ? error.message : "Compaction could not be sent. Try again.",
      );
    });
  };
  const shownError = threadError ?? compactFailure;
  const dismissShownError = () => {
    if (threadError) onDismissThreadError();
    else setCompactFailure(null);
  };
  const first = Object.entries(repoRevisions ?? {})[0];
  return (
    <ReplyComposer
      engine={defaultEngine}
      model={defaultModel}
      memoryScope={defaultMemoryScope}
      pending={pendingReply !== null}
      commands={commands}
      commandState={commandState}
      modelSelection={modelSelection}
      locked={controlLocksComposer || composerLocked}
      placeholder={
        pendingApproval
          ? "Respond to the approval above to continue…"
          : pendingQuestion
            ? composerCanAnswerQuestion
              ? "Answer Agent’s question…"
              : "Answer the question above to continue…"
            : composerLocked
              ? (composerLockedMessage ?? "Loading thread controls…")
              : running
                ? "Add context while this runs"
                : assistantIdentity
                  ? `Message ${assistantIdentity.name}`
                  : undefined
      }
      onReply={onReply}
      running={running}
      stopError={stopError}
      threadError={shownError}
      onDismissThreadError={dismissShownError}
      notice={handoffNotice}
      onDismissNotice={onDismissHandoffNotice}
      engineUnavailable={engineUnavailable}
      engineUnavailableMessage={engineUnavailableMessage}
      draftKey={turns[0]?.run.id ?? null}
      prefill={prefill}
      enableMentions={resourceMentions && composerAcceptsRunResources(pendingQuestion ?? null)}
      enableUploads={composerAcceptsRunResources(pendingQuestion ?? null)}
      repoRevisions={repoRevisions}
      lead={
        <>
          {runningTurn && runningStatus && (
            <RunningFooter
              status={runningStatus}
              model={modelLabel(runningTurn.run.model, defaultEngine)}
              startedAt={runStartedAt}
              onStop={onStop}
              stopping={stopping}
            />
          )}
          <QueuedMessages
            messages={queued}
            sendNowFor={runningTurn ? sendNowFor : null}
            onSendNow={onSendNow}
            onRemove={onRemoveQueued}
          />
        </>
      }
      status={
        <ComposerStatusBar
          branch={first?.[1] ?? null}
          project={first?.[0]?.split("/").at(-1) ?? null}
          agent={engineDisplayLabel(defaultEngine)}
          context={context}
          onCompact={canCompact ? compact : undefined}
        />
      }
    />
  );
}
