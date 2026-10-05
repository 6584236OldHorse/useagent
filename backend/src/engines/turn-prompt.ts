import { productChildThreadsEnabled } from "../runs/thread-relationship-switch";
import { MEMORY_TURN_GUIDANCE, MEMORY_TURN_GUIDANCE_NO_TOOLS } from "../memory/memory-skill-text";

/** The provider-neutral context needed to compose one agent turn. */
export interface TurnPromptContext {
  readonly prompt: string;
  readonly bootstrapContext: string;
  /** Prior thread turns a RESUMED session never saw (they failed before any engine
   *  ran). A fresh session gets them through bootstrapContext instead. */
  readonly unseenTurnsContext?: string;
  readonly turnContext: string;
  readonly memoryEnabled?: boolean;
  readonly resourceContext?: string;
  readonly skillContext?: string;
  readonly skillCatalogContext?: string;
  /** Controller-only bot roster and delegation policy; absent on bot-owned/chat turns. */
  readonly botContext?: string;
  readonly inputContext?: string;
  readonly commandName?: string | null;
  readonly orgId?: string | null;
  readonly origin?: string | null;
  /** The conversation the run belongs to; names the port bridge the user opens. */
  readonly threadId?: string;
  /** Says a fresh sandbox replaced the thread's earlier one; follows turnContext. */
  readonly workspaceNotice?: string;
  /** What a resumed session already holds; absent or null sends every block. */
  readonly priorPreamble?: PreambleHashes | null;
}

/**
 * Global agent operating rules, injected once per fresh native session. A
 * resumed session already holds them in its native history, just like the
 * reconstructed bootstrap context.
 */
export const AGENT_OPERATING_RULES =
  "<operating_rules>\n" +
  "If a required tool, API, credential, or file is unavailable or repeatedly returns " +
  "auth/permission errors (401/403), not-found, or empty results, do NOT sleep-and-retry " +
  "it in a loop. Treat that dependency as unavailable: skip the sub-step it blocks, do " +
  "everything else the task allows, and finish. A partial result that explicitly names " +
  "what was skipped and why is far better than hanging until a timeout. Never block a " +
  "whole task on one missing dependency. When browser tools are available, reuse the " +
  "existing visible tab and prefer bounded DOM/locator actions. On complex dynamic pages, " +
  "never request an unbounded full accessibility snapshot: limit it by target or depth. " +
  "If structural inspection times out once, switch to a viewport screenshot plus coordinate " +
  "tools instead of repeating the same snapshot. Do not close the browser unless the user " +
  "asks you to. Inspection screenshots stay internal; publish an artifact only when the user " +
  "requests a screenshot file or durable proof.\n" +
  "</operating_rules>\n\n";

/** Repeated every turn so a resident provider sees current workflow policy. */
export const AGENT_WORKFLOW_ROUTING_RULES =
  "<workflow_routing>\n" +
  "Do not guess a skill from keywords, improvise a known workflow, or ask for an org, " +
  "repository, or account identifier when an activated procedure and trusted gateway can resolve " +
  "it from the authenticated workspace. For recurring or scheduled work, use the trusted " +
  "automation_list / automation_create / automation_update / automation_run_now / automation_history / " +
  "automation_delete tools for UseAgent automations; only discuss external scheduler products when " +
  "the user explicitly asks about those products.\n" +
  "</workflow_routing>\n\n";

export const AGENT_SKILL_DISCOVERY_RULES =
  "<skill_discovery>\n" +
  "When no exact explicit skill is already active, before any non-trivial organization " +
  "workflow: if a listed skill_catalog entry fits by meaning, call skill_activate with its exact " +
  "id directly. Call skills_list only when no listed entry fits, then activate the best-fitting " +
  "procedure by its exact returned id before acting.\n" +
  "</skill_discovery>\n\n";

function productFanoutRoutingRules(
  ctx: TurnPromptContext,
  executionCapabilities: ExecutionCapabilitySnapshot,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const tools = executionCapabilities.facilities.tools;
  const gatewayAvailable =
    tools.availability === "ready" && tools.access.kind === "useagent_gateway";
  const productFanoutAvailable = gatewayAvailable && ctx.origin === null &&
    productChildThreadsEnabled(env);
  if (!productFanoutAvailable) return "";
  return "<delegation_routing>\n" +
    "When the user explicitly asks to fan out, delegate, parallelize work across agents, or create " +
    "user-visible child sessions, you MUST use the trusted child_session_create_many tool. Those " +
    "product child sessions are the durable, independently visible delegation boundary. Even when " +
    "the user does not explicitly request fan-out, you MUST use child_session_create_many when the " +
    "request has at least two substantial independent workstreams whose concurrent execution materially " +
    "helps and whose progress or result should remain visible and messageable. This includes multi-subject " +
    "research or comparison requests where each subject requires its own sourced analysis. Keep small, sequential, approval-bound, " +
    "destructive, or shared-state-conflicting work in the parent. After delegating outcome work, do not " +
    "claim the overall task is complete until child_session_gather shows the relevant children settled; " +
    "read their bounded child_session_events and synthesize the results. Do not busy-poll: if children " +
    "are still running, report that honestly and let their durable UI continue updating. Native " +
    "harness subagents are only for internal decomposition within the current product session and " +
    "must not substitute for requested user-visible fan-out. Use native subagents only when the " +
    "user explicitly requests native/internal subagents or when privately decomposing one product " +
    "child's assigned task.\n" +
    "</delegation_routing>\n\n";
}

/** A port the agent serves inside its sandbox is unreachable as localhost from
 * the user's browser; the product bridges it. Tell the agent the URL to print. */
function servedPortsContext(
  ctx: TurnPromptContext,
  executionCapabilities: ExecutionCapabilitySnapshot,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const origin = env.FRONTEND_ORIGIN?.trim();
  if (executionCapabilities.runtime !== "sandbox" || !ctx.threadId || !origin) return "";
  return "<served_ports>\n" +
    "Nothing you serve inside the workspace is reachable by the user as localhost. A server " +
    `listening on port N (bind it to 0.0.0.0) opens for the user at ${portProxyUrl(origin, ctx.threadId, "N")} ` +
    "with N replaced by the real port. When you start a dev server, serve a directory or " +
    "expose a preview, print that URL instead of a localhost link.\n" +
    "</served_ports>\n\n";
}

/** Content hashes of the preamble blocks a native session holds: the fixed rule
 * blocks and the skill catalog page. Stored with the run that delivered them. */
export interface PreambleHashes {
  readonly rules: string;
  readonly catalog: string;
}

/** The blocks a resumed session is sent only when they changed since it last
 * received them. The skill discovery rule belongs to the rules unless a pinned
 * skill governs the turn, which also replaces the catalog. */
function preambleBlocks(
  ctx: TurnPromptContext,
  executionCapabilities: ExecutionCapabilitySnapshot,
  env: Readonly<Record<string, string | undefined>>,
): { readonly rules: string; readonly catalog: string } {
  return {
    rules: executionCapabilityPrompt(executionCapabilities) +
      AGENT_WORKFLOW_ROUTING_RULES +
      productFanoutRoutingRules(ctx, executionCapabilities, env) +
      servedPortsContext(ctx, executionCapabilities, env) +
      (ctx.skillContext ? "" : AGENT_SKILL_DISCOVERY_RULES),
    catalog: ctx.skillContext ? "" : (ctx.skillCatalogContext ?? ""),
  };
}

const preambleHash = (text: string): string =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 32);

/** The preamble hashes a session holds once this turn's prompt is delivered. */
export function turnPreambleHashes(
  ctx: TurnPromptContext,
  executionCapabilities: ExecutionCapabilitySnapshot,
  env: Readonly<Record<string, string | undefined>> = process.env,
): PreambleHashes {
  const blocks = preambleBlocks(ctx, executionCapabilities, env);
  return { rules: preambleHash(blocks.rules), catalog: preambleHash(blocks.catalog) };
}

/**
 * Compose the exact text sent to an engine for one turn. Fresh sessions receive
 * reconstructed thread history and global rules. Resumed sessions receive the
 * thread turns their native history lacks, the rule blocks and skill catalog
 * only when they changed since the session last received them (priorPreamble),
 * then the per-turn skill, upload, and memory context before the user's prompt.
 * Validated native commands are delivered byte-verbatim.
 */
export function composeTurnPrompt(
  ctx: TurnPromptContext,
  resumed: boolean,
  executionCapabilities: ExecutionCapabilitySnapshot,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (ctx.commandName) return ctx.prompt;
  // Bots are reachable only through the gateway tools; a turn that cannot reach them
  // (no gateway, or an internal origin such as Slack) must not be told to use them.
  const tools = executionCapabilities.facilities.tools;
  const gatewayReachable = tools.availability === "ready" && tools.access.kind === "useagent_gateway";
  const botsReachable = gatewayReachable && ctx.origin === null;
  // Memory works through the same gateway tools on every origin (automations and
  // handoffs included); a session without them is told so rather than left to
  // invent a memory file in the sandbox. Said once per session with the operating
  // rules: a resumed session still holds it, and only the recalled facts change.
  const memoryRules = ctx.memoryEnabled ? (gatewayReachable ? MEMORY_TURN_GUIDANCE : MEMORY_TURN_GUIDANCE_NO_TOOLS) : "";
  const blocks = preambleBlocks(ctx, executionCapabilities, env);
  const held = resumed ? ctx.priorPreamble : null;
  const perTurn =
    (held?.rules === preambleHash(blocks.rules) ? "" : blocks.rules) +
    (botsReachable ? (ctx.botContext ?? "") : "") +
    (ctx.skillContext ?? "") +
    (held?.catalog === preambleHash(blocks.catalog) ? "" : blocks.catalog) +
    (ctx.resourceContext ?? "") +
    (ctx.inputContext ?? "") +
    ctx.turnContext +
    (ctx.workspaceNotice ?? "");
  const prefix = resumed
    ? (ctx.unseenTurnsContext ?? "") + perTurn
    : AGENT_OPERATING_RULES + memoryRules + ctx.bootstrapContext + perTurn;
  return `${prefix}<current_user_request>\n${ctx.prompt}\n</current_user_request>`;
}

/**
 * The adapter-side compose: waits for the context the worker gathers while the
 * sandbox is prepared, records what was recalled, then composes. It also notes
 * the preamble the session will hold, which the delivery stamp stores; a native
 * command sends none, so the next turn sends the blocks again (a compaction may
 * have dropped them).
 */
export async function composeRunTurnPrompt(
  ctx: EngineRunContext,
  resumed: boolean,
  executionCapabilities: ExecutionCapabilitySnapshot,
): Promise<string> {
  if (ctx.pendingTurnContext) {
    const ready = await ctx.pendingTurnContext;
    Object.assign(ctx, ready.parts);
    await ready.recordRetrieval();
  }
  ctx.signal.throwIfAborted();
  ctx.deliveredPreamble = ctx.commandName ? null : turnPreambleHashes(ctx, executionCapabilities);
  return composeTurnPrompt(ctx, resumed, executionCapabilities);
}
import type { ExecutionCapabilitySnapshot } from "@useagent/agent-harness/canonical";
import type { EngineRunContext } from "./types";
import { executionCapabilityPrompt } from "./execution-capabilities";
import { portProxyUrl } from "../runs/port-proxy-url";
