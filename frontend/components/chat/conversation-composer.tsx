"use client";

import { useMemo, useState } from "react";
import type { PendingApproval } from "@/components/chat/approval-state";
import type { CommandCatalogState } from "@/components/chat/canonical-timeline";
import type { ComposerSubmit } from "@/components/chat/composer";
import type { AssistantIdentity, Turn } from "@/components/chat/conversation";
import { latestThreadContext } from "@/components/chat/native-events";
import {
  composerAcceptsRunResources,
  type PendingQuestion,
} from "@/components/chat/question-state";
import { ReplyComposer } from "@/components/chat/reply-composer";
import type { SlashCommand } from "@/components/chat/slash-command";
import type { EngineId, MemoryScope, PermissionMode } from "@/components/chat/types";
import { ComposerStatusBar } from "@/components/pro/composer-status-bar";
import { PermissionModeChip } from "@/components/pro/permission-mode-chip";
import { engineDisplayLabel } from "@/components/session-ui/provider-status-banner";

/**
 * The reply composer of a thread plus its status row: the placeholder for the
 * thread's state, the status bar (branch, project, permission chip, engine,
 * context meter) and the Compact now action, which is offered only while
 * nothing is pending, queued or running, and whose refusal shows in the same
 * banner a failed turn uses. Dismissing the banner clears only the error it is
 * showing. The permission chip follows the thread's newest turn until the
 * person picks a mode; every reply then carries that choice.
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
  // The chip follows the thread's newest turn until the person picks a mode; a
  // legacy turn that reported none reads as full access, the posture it ran with.
  const [chosenMode, setChosenMode] = useState<PermissionMode | null>(null);
  const permissionMode = chosenMode ?? turns.at(-1)?.run.permission_mode ?? "full-access";
  const reply: ComposerSubmit = (text, engine, model, key, scope, command, attachments, resources, bots) =>
    onReply(text, engine, model, key, scope, command, attachments, resources, bots, permissionMode);
  const [compactFailure, setCompactFailure] = useState<string | null>(null);
  const canCompact =
    !running &&
    pendingReply === null &&
    !turns.some((turn) => turn.status === "queued") &&
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
              : assistantIdentity
                ? `Message ${assistantIdentity.name}`
                : undefined
      }
      onReply={reply}
      running={running}
      stopping={stopping}
      stopError={stopError}
      onStop={onStop}
      runStartedAt={runStartedAt}
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
      status={
        <ComposerStatusBar
          branch={first?.[1] ?? null}
          project={first?.[0]?.split("/").at(-1) ?? null}
          permission={<PermissionModeChip mode={permissionMode} onChange={setChosenMode} />}
          agent={engineDisplayLabel(defaultEngine)}
          context={context}
          onCompact={canCompact ? compact : undefined}
        />
      }
    />
  );
}
