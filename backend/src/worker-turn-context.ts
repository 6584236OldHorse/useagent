import type { getRun, ThreadProviderSessionState } from "./runs/repo";
import { threadHistoryForTurn } from "./runs/thread-history";
import type { RunStageTimer } from "./runs/run-timing";
import { recallScopedMemory } from "./memory/team-memory";
import type { ScopedMemoryPlan } from "./memory/scope";
import { recordContextRetrieval } from "./memory/retrieval-ledger";
import { listSkillCatalogForOrg } from "./skills/repo";
import { formatSkillCatalogPrefill, shouldPrefillSkillCatalog } from "./skills/catalog";
import { buildResourceAccessSnapshot } from "./resources/access-snapshot";
import { botContextForTurn, NO_BOT_TURN_CONTEXT } from "./bots/prompt-context";
import { frameTurnContexts } from "./engines/turn-contexts";
import type { PendingTurnContext } from "./engines/types";
import { errorMessage } from "./util/error-message";

type WorkerRun = NonNullable<Awaited<ReturnType<typeof getRun>>>;

/** Recall on the turn path gets one overall budget: memory is reference material,
 *  never worth holding a turn for. */
export const TURN_RECALL_DEADLINE_MS = 1_500;

/** A short follow-up with no question ("ok", "thanks!") asks memory nothing new. */
export function isShortAcknowledgement(prompt: string): boolean {
  const text = prompt.trim();
  return text.length < 12 && !text.includes("?");
}

/** Gathering the turn context failed. The worker fails the run with the cause,
 *  exactly as when it gathered the context before starting the engine. */
export class TurnContextError extends Error {
  constructor(cause: unknown) {
    super(errorMessage(cause), { cause });
  }
}

/**
 * Start gathering a turn's prompt-only context: bot assignment, memory recall,
 * thread history, skill catalog page and resource snapshot, in parallel. It runs
 * while the adapter acquires the sandbox and starts the session; the adapter
 * awaits it just before composing the prompt (composeRunTurnPrompt), which also
 * records the retrieval ledger then. Starts only after the run was marked
 * started, inside its admission. A failure rejects with TurnContextError, marked
 * handled here so a turn that fails earlier never leaves it unhandled.
 */
export function gatherTurnContext(input: {
  readonly run: WorkerRun;
  readonly plan: ScopedMemoryPlan | null;
  readonly skillContext: string;
  readonly providerSessionState: Promise<ThreadProviderSessionState>;
  readonly stageLedger: RunStageTimer | null;
}): Promise<PendingTurnContext> {
  const pending = gather(input).catch((error: unknown) => {
    throw new TurnContextError(error);
  });
  pending.catch(() => {});
  return pending;
}

async function gather({
  run,
  plan,
  skillContext,
  providerSessionState,
  stageLedger,
}: Parameters<typeof gatherTurnContext>[0]): Promise<PendingTurnContext> {
  const timed = async <T>(stage: string, operation: () => Promise<T>): Promise<T> => {
    const end = stageLedger?.begin(stage);
    try {
      return await operation();
    } finally {
      end?.();
    }
  };
  // A follow-up that only acknowledges keeps the memory its session already holds.
  const skipRecall = run.parentRunId !== null && isShortAcknowledgement(run.prompt);
  const [bot, recall, history, skillCatalogPage, resourceSnapshot] = await timed("worker.context", () => Promise.all([
    run.commandName
      ? NO_BOT_TURN_CONTEXT
      : botContextForTurn({ orgId: run.orgId, threadId: run.threadId, engine: run.engine }),
    // Layered recall (new_mem_prompt.md 6.2): L0 (immediate ground evidence,
    // incl. explicit "remember X") and L1 (distilled) searched in parallel and
    // merged, so a freshly taught fact reaches a NEW thread before extraction.
    timed("worker.memory_recall", () =>
      plan && !skipRecall
        ? recallScopedMemory(run.prompt, plan.readPools, { timeoutMs: TURN_RECALL_DEADLINE_MS })
        : Promise.resolve(null),
    ),
    timed("worker.thread_preamble", () => threadHistoryForTurn(run)),
    timed("worker.skill_catalog", async () => {
      const state = await providerSessionState;
      const engineSessionId = state.binding?.nativeSessionId ?? state.legacySessionId ?? undefined;
      if (
        !shouldPrefillSkillCatalog({
          hasPinnedSkill: skillContext.length > 0,
          commandName: run.commandName ?? null,
          orgId: run.orgId,
          engineSessionId,
        }) ||
        run.orgId === null
      ) {
        return null;
      }
      try {
        return formatSkillCatalogPrefill(await listSkillCatalogForOrg(run.orgId), run.prompt);
      } catch (error) {
        console.warn(
          `[worker] skill catalog prefill failed for run ${run.id}; falling back to skills_list discovery:`,
          error,
        );
        return null;
      }
    }),
    timed("worker.resource_access", () =>
      run.orgId && run.userId
        ? buildResourceAccessSnapshot({
            orgId: run.orgId,
            userId: run.userId,
            runId: run.id,
            resources: run.resolvedResources ?? [],
            repos: run.repos ?? [],
          })
        : Promise.resolve(null),
    ),
  ]));
  const { turnContext, skillCatalogContext, resourceContext } = frameTurnContexts({
    recall,
    skillCatalogPage,
    resourceSnapshot,
    botIdentity: bot.identity,
  });
  if (turnContext || history.bootstrapContext || history.unseenTurnsContext || skillContext || skillCatalogContext || resourceContext) {
    console.log(
      `[worker] run ${run.id} thread ${run.threadId} scope=${plan?.scope ?? "off"}: ` +
        `turnContext ${turnContext.length} (${recall?.items.length ?? 0} memory items, ` +
        `${recall?.latencyMs ?? 0}ms) + bootstrapContext ${history.bootstrapContext.length} + unseenTurnsContext ${history.unseenTurnsContext.length}` +
        ` + skillContext ${skillContext.length} chars` +
        ` + skillCatalogContext ${skillCatalogContext.length} chars` +
        ` + resourceContext ${resourceContext.length} chars`,
    );
  }
  return {
    parts: { ...history, turnContext, resourceContext, skillCatalogContext, botContext: bot.delegation },
    // Retrieval ledger (Phase 3a): durably record + stream what was recalled as a
    // `context.retrieved` native frame, awaited before the prompt is sent (a
    // crash must not lose the record of what context a run used). A persist
    // failure is logged, never fails the run.
    recordRetrieval: async () => {
      if (!plan || !recall) return;
      await timed("worker.context_marker", () =>
        recordContextRetrieval(run.id, run.threadId, plan, run.prompt, recall).catch((err) =>
          console.warn(`[worker] context.retrieved marker persist failed for run ${run.id}:`, err),
        ),
      );
    },
  };
}
