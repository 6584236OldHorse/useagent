/**
 * Slack-native streaming grammar. The chunk shapes here mirror the documented
 * wire contract of chat.startStream / chat.appendStream / chat.stopStream
 * (docs.slack.dev): flat `task_update` objects (`id`/`title`/`status`),
 * `plan_update` with a `title`, `markdown_text` carrying `text`, and a
 * `task_display_mode` of `timeline` or `plan`.
 *
 * Everything in this module is PURE (no I/O) so each shape and translation is
 * unit-testable with fixtures: steps become task updates, plan/todo steps
 * become plan updates, and narration deltas become exact-offset markdown
 * segments. The outbox owns delivery; the watcher and run finalization own
 * sequencing.
 */
import type { CardPhase } from "./card";

export type SlackStreamTaskDisplayMode = "timeline" | "plan";
export type SlackSessionStatus = "processing" | "active";
export type SlackTaskUpdateStatus = "in_progress" | "complete" | "error";

export type SlackMarkdownStreamChunk = {
  readonly type: "markdown_text";
  readonly text: string;
};

export type SlackTaskUpdateStreamChunk = {
  readonly type: "task_update";
  readonly id: string;
  readonly title: string;
  readonly status: SlackTaskUpdateStatus;
  readonly details?: string;
  readonly output?: string;
  readonly sources?: readonly { readonly type: "url"; readonly text: string; readonly url: string }[];
};

export type SlackPlanUpdateStreamChunk = {
  readonly type: "plan_update";
  readonly title: string;
};

export type SlackStreamChunk =
  | SlackMarkdownStreamChunk
  | SlackTaskUpdateStreamChunk
  | SlackPlanUpdateStreamChunk;

/** Task/plan chunk text tops out at 256 chars (Slack docs); stay under it. */
const TASK_TEXT_CAP = 250;
/** One markdown chunk tops out at 12,000 chars (Slack docs); stay under it. */
const MARKDOWN_CHUNK_CAP = 10_000;
/** Total narration streamed into one message body. Past this the watcher stops
 *  appending and the final reply is delivered whole at stopStream instead. */
export const STREAM_NARRATION_CAP = 12_000;

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Split free text into markdown chunks WITHOUT altering a single character -
 *  narration offsets count source chars, so truncation here would corrupt the
 *  tail arithmetic at stopStream. Empty text yields no chunks. */
export function markdownChunksFor(text: string): SlackMarkdownStreamChunk[] {
  const chunks: SlackMarkdownStreamChunk[] = [];
  for (let at = 0; at < text.length; at += MARKDOWN_CHUNK_CAP) {
    chunks.push({ type: "markdown_text", text: text.slice(at, at + MARKDOWN_CHUNK_CAP) });
  }
  return chunks;
}

export function taskUpdateChunk(input: {
  readonly id: string;
  readonly title: string;
  readonly status: SlackTaskUpdateStatus;
  readonly details?: string | null;
  readonly output?: string | null;
  readonly sources?: readonly string[];
}): SlackTaskUpdateStreamChunk {
  return {
    type: "task_update",
    id: truncate(input.id, TASK_TEXT_CAP) || "task",
    title: truncate(input.title, TASK_TEXT_CAP) || "Working",
    status: input.status,
    ...(input.details ? { details: truncate(input.details, TASK_TEXT_CAP) } : {}),
    ...(input.output ? { output: truncate(input.output, TASK_TEXT_CAP) } : {}),
    ...(input.sources?.length
      ? { sources: input.sources.map((url) => ({ type: "url" as const, text: url, url })) }
      : {}),
  };
}

/** An absolute http(s) URL Slack will accept as a source link. */
function httpUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** The url sources of a stored task card, re-validated to the documented
 *  shape on the way out of the outbox (a spread: empty when none survive). */
export function taskSourcesField(value: unknown): Pick<SlackTaskUpdateStreamChunk, "sources"> {
  const sources = (Array.isArray(value) ? value : []).flatMap((raw) => {
    const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
    return source?.type === "url" && typeof source.url === "string" && httpUrl(source.url) && typeof source.text === "string" && source.text
      ? [{ type: "url" as const, text: source.text, url: source.url }]
      : [];
  });
  return sources.length > 0 ? { sources } : {};
}

/** Normalize stored chunks to the DOCUMENTED wire shape on the way out of the
 *  outbox. Pre-migration rows carried a `markdown_text` text field,
 *  `task_update` fields nested under `task` (with `task_id`), and plan items
 *  typed `task` - Slack rejected all of them, so legacy plan items are dropped
 *  and the rest are converted. */
export function streamChunksFrom(value: unknown): readonly SlackStreamChunk[] {
  return Array.isArray(value)
    ? value.map(normalizeStreamChunk).filter((chunk): chunk is SlackStreamChunk => chunk !== null)
    : [];
}

function normalizeStreamChunk(raw: unknown): SlackStreamChunk | null {
  const chunk = rec(raw);
  if (!chunk) return null;
  if (chunk.type === "markdown_text") {
    // Never trimmed: narration offsets count these chars exactly.
    const text = [chunk.text, chunk.markdown_text].find((t) => typeof t === "string" && t) as string | undefined;
    return text ? { type: "markdown_text", text } : null;
  }
  if (chunk.type === "plan_update") {
    const title = str(chunk.title);
    return title ? { type: "plan_update", title } : null;
  }
  if (chunk.type !== "task_update") return null;
  const source = rec(chunk.task) ?? chunk;
  const id = str(source.id) ?? str(source.task_id);
  const title = str(source.title);
  const status =
    source.status === "in_progress" || source.status === "complete" || source.status === "error"
      ? source.status
      : null;
  if (!id || !title || !status) return null;
  const details = str(source.details);
  const output = str(source.output);
  return {
    type: "task_update",
    id,
    title,
    status,
    ...(details ? { details } : {}),
    ...(output ? { output } : {}),
    ...taskSourcesField(source.sources),
  };
}

export function planUpdateChunk(title: string): SlackPlanUpdateStreamChunk {
  return { type: "plan_update", title: truncate(title, TASK_TEXT_CAP) || "Plan" };
}

/** The stream's opening: one root task card spinning on the run title. No
 *  markdown here - every streamed char stays in the settled message body. */
export function openingStreamChunks(title: string): readonly SlackStreamChunk[] {
  return [taskUpdateChunk({ id: "run", title, status: "in_progress" })];
}

// ── Tool cards ───────────────────────────────────────────────────────────────
// The verb table mirrors the web UI's tool rows (frontend/components/chat/
// tool-summary.ts, describeKnownTool + the shell/file branches): the same tool
// names read as the same past-tense line here, with the query/path/command as
// the card's details.

type StepLike = {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly chip: string | null;
  readonly code_json: string | null;
};

const SHELL_TOOLS = new Set(["bash", "shell", "execute", "command_execution"]);
const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path"] as const;

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function firstLine(text: string): string {
  return text.split("\n")[0]!.trim();
}

function pathOf(args: Record<string, unknown> | null): string | null {
  const files = Array.isArray(args?.files) ? args.files : [];
  return PATH_KEYS.map((key) => str(args?.[key])).find(Boolean) ?? str(rec(files[0])?.path);
}

function commandOf(raw: unknown): string | null {
  if (Array.isArray(raw)) return str(raw.filter((part) => typeof part === "string").join(" "));
  return str(raw);
}

function knownToolCard(
  name: string,
  args: Record<string, unknown> | null,
): { title: string; details: string | null } | null {
  const query = str(args?.query);
  const named = str(args?.name) ?? str(args?.skill) ?? str(args?.skill_name) ?? str(args?.id);
  switch (name.toLowerCase()) {
    case "memory_search":
    case "memory_read":
      return { title: "Recalled memory", details: query };
    case "memory_remember":
      return { title: "Remembered", details: null };
    case "memory_correct":
      return { title: "Corrected memory", details: null };
    case "memory_forget":
      return { title: "Forgot memory", details: null };
    case "skill":
    case "skill_activate":
    case "skills_activate":
      return { title: "Activated playbook", details: named };
    case "skill_list":
    case "skills_list":
    case "skill_search":
    case "skills_search":
      return { title: "Searched playbooks", details: query };
    case "gateway_tools_search":
      return { title: "Searched tools", details: query };
    case "gateway_tool_describe":
      return { title: "Described tool", details: named };
    case "websearch":
    case "web_search":
      return { title: "Searched the web", details: query };
    case "webfetch":
    case "web_fetch":
    case "fetch":
      return { title: "Fetched a page", details: str(args?.url) };
    case "read":
    case "read_file":
      return { title: "Read a file", details: pathOf(args) };
    default:
      return null;
  }
}

/** One task card for a tool call, or null for what a coworker would not
 *  mention: the boot and runtime chatter (`task` rows that are not subagents,
 *  such as "Preparing context", "Waiting for provider activity", "Context
 *  window updated") and the done marker. Pure and re-derived from the step on
 *  every revision, so the SAME id updates the card in place: in_progress while
 *  the call runs, complete or error once it settles. */
export function toolTaskChunk(step: StepLike): SlackTaskUpdateStreamChunk | null {
  if (step.kind === "done" || (step.kind === "task" && step.chip !== "subagent")) return null;
  let code: Record<string, unknown> | null = null;
  try {
    code = step.code_json ? rec(JSON.parse(step.code_json)) : null;
  } catch {
    code = null;
  }
  const input = rec(code?.input);
  // The gateway's bridge (`execute` / `gateway_tool_call`) carries the real
  // tool as input.name (input.tool on codex) plus input.arguments.
  const bridged = str(input?.name) ?? str(input?.tool);
  const args = (bridged ? rec(input?.arguments) : null) ?? input;
  const tool = (bridged ?? str(code?.tool) ?? "").split(/__|[./]/).filter(Boolean).pop() ?? "";
  // A plan/todos row travels as plan_update, never as a card.
  if (step.chip === "plan" || tool === "todowrite") return null;
  const command = commandOf(input?.command ?? code?.command);
  const card =
    knownToolCard(tool, args) ??
    (step.kind === "file"
      ? { title: "Edited a file", details: pathOf(args) }
      : command || SHELL_TOOLS.has(tool.toLowerCase())
        ? { title: "Ran a command", details: command }
        : { title: step.label, details: pathOf(args) ?? str(args?.query) ?? str(args?.url) });
  const activityKind = str(code?.activityKind);
  const output = str(code?.output);
  // A T3 revision names its lifecycle; a native bridge row completes when its
  // output key lands (possibly empty), and the error flag wins either way.
  const status: SlackTaskUpdateStatus = code?.error
    ? "error"
    : activityKind
      ? /\.(started|updated|progress)$/.test(activityKind) ? "in_progress" : "complete"
      : typeof code?.output === "string"
        ? "complete"
        : "in_progress";
  return taskUpdateChunk({
    id: `step_${step.id}`,
    title: card.title,
    status,
    details: card.details ? firstLine(card.details) : null,
    // A JSON payload is never a line a person reads; the first prose line is.
    output: output && !/^[[{]/.test(output) ? firstLine(output) : null,
    sources: sourceUrls(output ?? ""),
  });
}

/** Distinct http(s) URLs a tool's output mentions, capped at five: trailing
 *  punctuation and the delimiter that wrapped the link are shed, a bracket
 *  that belongs to the URL (an IPv6 host, a wiki title) stays, and anything
 *  the URL parser rejects is out. */
function sourceUrls(text: string): string[] {
  const candidates = (text.match(/https?:\/\/[^\s<>"']+/g) ?? []).map(unwrapUrl);
  return [...new Set(candidates.filter(httpUrl))].slice(0, 5);
}

const OPENER: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Shed a trailing closer only while it outnumbers its opener inside the
 *  candidate, so `(https://x.dev/a).` yields `https://x.dev/a` while
 *  `http://[::1]:3000/health` and `https://w.org/Foo_(bar)` keep theirs. */
function unwrapUrl(raw: string): string {
  let url = raw;
  for (;;) {
    url = url.replace(/[.,;:!?]+$/, "");
    const closer = url.at(-1) ?? "";
    const opener = OPENER[closer];
    if (!opener || url.split(closer).length <= url.split(opener).length) return url;
    url = url.slice(0, -1);
  }
}

/** Progress chunks for a card revision: a card still open under another id
 *  completes first (a new call starting means the last one yielded, for engines
 *  that never send a completion), then the revision itself. Returns the card
 *  left open, if any. Pure state-in/state-out so the pairing is unit-testable. */
export function stepProgressChunks(
  open: SlackTaskUpdateStreamChunk | null,
  chunk: SlackTaskUpdateStreamChunk,
): { chunks: readonly SlackTaskUpdateStreamChunk[]; open: SlackTaskUpdateStreamChunk | null } {
  const yielded =
    chunk.status === "in_progress" && open !== null && open.id !== chunk.id && open.status === "in_progress";
  return {
    chunks: yielded ? [{ ...open, status: "complete" }, chunk] : [chunk],
    open: chunk.status === "in_progress" ? chunk : open?.id === chunk.id ? null : open,
  };
}

/** A plan/todos step (todowrite tool or a `plan` chip) becomes ONE plan_update
 *  chunk titling the plan's live progress. Null for a non-plan step. */
export function planUpdateFromStep(step: {
  readonly label: string;
  readonly chip: string | null;
  readonly codeJson: string | null;
}): SlackPlanUpdateStreamChunk | null {
  let parsed: unknown;
  try {
    parsed = step.codeJson ? JSON.parse(step.codeJson) : null;
  } catch {
    parsed = null;
  }
  const code = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  const tool = typeof code?.tool === "string" ? code.tool : null;
  if (step.chip !== "plan" && tool !== "todowrite") return null;
  const input = code?.input && typeof code.input === "object" ? (code.input as Record<string, unknown>) : null;
  const todos = Array.isArray(input?.todos)
    ? input.todos.filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object")
    : [];
  if (todos.length === 0) return planUpdateChunk(step.label);
  const done = todos.filter((t) => {
    const status = typeof t.status === "string" ? t.status : "";
    return status === "completed" || status === "complete" || status === "done";
  }).length;
  const current = todos.find((t) => t.status === "in_progress");
  const currentText = typeof current?.content === "string" ? current.content : null;
  const head = `Plan ${done}/${todos.length}`;
  return planUpdateChunk(currentText ? `${head}: ${currentText}` : head);
}

/** Chars of card JSON the stop restates at most, so finalization never builds
 *  a payload the outbox refuses: the newest cards win, and an open card past
 *  the budget still closes with a bare id/title/status. */
export const TERMINAL_CARD_BUDGET = 6_000;

/** Terminal task closures for stopStream: the recent tool cards restated from
 *  their durable rows (a card still open settles to complete/error, a settled
 *  one is repeated as is, since a live append pending at finalization is
 *  dropped) and the root run task. The reply text itself travels separately
 *  (narration tail + closing markdown, sliced at delivery). */
export function terminalTaskChunks(input: {
  readonly phase: CardPhase;
  readonly title: string;
  readonly cards?: readonly SlackTaskUpdateStreamChunk[];
  readonly budget?: number;
}): readonly SlackStreamChunk[] {
  const status: SlackTaskUpdateStatus = input.phase === "failed" ? "error" : "complete";
  const budget = input.budget ?? TERMINAL_CARD_BUDGET;
  const restated: SlackTaskUpdateStreamChunk[] = [];
  let spent = 0;
  for (const card of (input.cards ?? []).toReversed()) {
    const settled = card.status === "in_progress" ? { ...card, status } : card;
    const size = JSON.stringify(settled).length;
    if (spent + size <= budget) {
      spent += size;
      restated.unshift(settled);
    } else if (card.status === "in_progress") {
      restated.unshift({ type: "task_update", id: card.id, title: card.title, status });
    }
  }
  return [
    ...restated,
    taskUpdateChunk({
      id: "run",
      title: input.phase === "failed" ? "Run failed" : input.title,
      status,
    }),
  ];
}

/** The markdown appended AFTER the narration tail at stopStream. Empty when the
 *  streamed narration already CONTAINS the reply (the common live case) -
 *  correctness first: when in doubt the reply is re-stated, never dropped. */
export function composeStreamClosing(input: {
  readonly status: "completed" | "failed";
  readonly summary: string;
  /** The narration the stream body will contain (already capped). */
  readonly narration: string;
}): string {
  const summary = input.summary.trim();
  const summaryCapped = truncate(summary, MARKDOWN_CHUNK_CAP);
  if (input.status === "failed") {
    const prefix = input.narration ? "\n\n" : "";
    return `${prefix}**Run failed**${summaryCapped ? `: ${summaryCapped}` : ""}`;
  }
  if (!input.narration) return summaryCapped || "Done.";
  if (!summary || input.narration.includes(summary)) return "";
  return `\n\n${summaryCapped}`;
}

/** Ordered narration accumulator for the watcher: deltas buffer in, `take()`
 *  drains the next exact-offset segment (capped in TOTAL so a chatty run cannot
 *  flood the thread). Pure + stateful factory, unit-testable without a run. */
export function createNarrationBuffer(cap = STREAM_NARRATION_CAP): {
  push(delta: string): void;
  take(): { text: string; offset: number } | null;
  streamed(): number;
} {
  let pending = "";
  let offset = 0;
  return {
    push(delta) {
      if (offset + pending.length >= cap) return;
      pending += delta;
    },
    take() {
      if (!pending) return null;
      const room = Math.max(0, cap - offset);
      const text = pending.slice(0, room);
      pending = "";
      if (!text) return null;
      const at = offset;
      offset += text.length;
      return { text, offset: at };
    },
    streamed() {
      return offset;
    },
  };
}

/** The live shimmer text for the working step ("<App> is working: <step>"). */
export function statusTextForStep(label: string): string {
  return `is working: ${truncate(label, 120)}`;
}

/** Slack DM channel ids start with "D" - the only surface where the free-text
 *  thread status (assistant.threads.setStatus) is documented to render. */
export function directMessageChannel(channelId: string): boolean {
  return channelId.startsWith("D");
}
