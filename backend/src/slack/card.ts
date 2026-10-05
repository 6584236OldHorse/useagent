/**
 * Block Kit THREAD CARD for a Slack-rooted thread. One card per Slack thread,
 * posted once (chat.postMessage) and advanced in place (chat.update) as its
 * turns run: a native `task_card` (spinner, tick or error glyph beside the
 * short run title; the model and repo folded behind its chevron as `details`;
 * the current step verb as `output` while a turn runs) followed by the
 * "Open in useAgent" button. Nothing else: no phase label, no divider, no
 * answer - every turn's answer is its own message under the card.
 *
 * PURE by design (no I/O, no Slack calls) so the card shape is unit-testable
 * with fixtures; the outbox (post_card/update_card) owns delivery.
 */
import type { RunStatus } from "../db/schema";
import type { RepoRef } from "../github/repo-ref";
import { codePointCut } from "./streaming";

/** The task_card status: a spinner while a turn runs, then a tick or an error glyph. */
export type CardStatus = "in_progress" | "complete" | "error";

/** Everything the pure builder needs. All strings pre-cleaned; no I/O here. */
export interface RunCardInput {
  /** The thread's task title (derived from the root prompt). */
  readonly title: string;
  readonly status: CardStatus;
  readonly model: string;
  /** Repos the thread is bound to (clean "owner/name" + optional branch). */
  readonly repoSpecs: readonly RepoRef[];
  /** The thread's web session URL (FRONTEND_ORIGIN/session/<threadId>). */
  readonly webUrl: string;
  /** The current step verb while a turn runs; absent once it settles. */
  readonly output?: string | null;
}

// Block Kit length caps (Slack docs): plain-text titles top out at 150 chars,
// rich_text is generous. Truncate defensively so a long title can never get
// the whole card rejected as invalid_blocks.
const CARD_TITLE_CAP = 148;
const RICH_TEXT_CAP = 2000;

/** Map a run's lifecycle status onto the card status. */
export function cardStatusFor(status: RunStatus): CardStatus {
  if (status === "completed") return "complete";
  if (status === "failed") return "error";
  return "in_progress";
}

/** The run's web session URL: FRONTEND_ORIGIN + "/session/" + threadId. Pure -
 *  the origin is passed in (callers read env.FRONTEND_ORIGIN). */
export function sessionUrl(origin: string, threadId: string): string {
  return `${origin.replace(/\/+$/, "")}/session/${threadId}`;
}

/** Truncate to `max` units on a code point (never inside a surrogate pair),
 *  adding an ellipsis. */
function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return t.slice(0, codePointCut(t, Math.max(0, max - 1))).trimEnd() + "…";
}

/** Slack mention markup as a reader sees it: a labelled user or channel keeps
 *  its label (`@dana`, `#general`), a broadcast keeps its word (`@here`), and
 *  a bare id is dropped so a raw `U05…` never shows. */
export function stripMentions(text: string): string {
  return text
    .replace(/<@[^>|]+\|([^>]*)>/g, "@$1")
    .replace(/<#[^>|]+\|([^>]*)>/g, "#$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/<!subteam\^[^>|]+\|@?([^>]*)>/g, "@$1")
    .replace(/<[@#!][^>]*>/g, "")
    .replace(/[ \t]{2,}/g, " ");
}

/** A thread title tops out well under Slack's cap: one short line. */
const TITLE_CAP = 64;

/** Derive a task title from a prompt: the first sentence of its first
 *  non-empty line (the whole line when that sentence is too short to stand
 *  alone), mention markup rendered or dropped, capped short. */
export function deriveTitle(prompt: string): string {
  const line = stripMentions(prompt).split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const sentence = line.match(/^(.*?[.!?])(?:\s|$)/)?.[1];
  const title = sentence && sentence.length >= 16 ? sentence : line;
  return truncate(title.replace(/\.$/, ""), TITLE_CAP) || "Run";
}

/** Render the repo binding as "owner/repo · branch", with "+N more" past the first. */
function repoSummary(repoSpecs: readonly RepoRef[]): string | null {
  if (repoSpecs.length === 0) return null;
  const first = repoSpecs[0]!;
  const head = first.branch ? `${first.repo} · ${first.branch}` : first.repo;
  const extra = repoSpecs.length - 1;
  return extra > 0 ? `${head}  +${extra} more` : head;
}

/** The line folded behind the chevron: model, then the repos when bound. */
function detailsText(model: string, repoSpecs: readonly RepoRef[]): string {
  const repos = repoSummary(repoSpecs);
  return truncate(repos ? `${model} · ${repos}` : model, RICH_TEXT_CAP);
}

/** One plain rich_text block (what task_card `details` and `output` take). */
function richText(text: string): unknown {
  return {
    type: "rich_text",
    elements: [{ type: "rich_text_section", elements: [{ type: "text", text }] }],
  };
}

/**
 * Build the Block Kit `blocks` array + the plain-text notification string for
 * the thread card. Pure: the same input always yields the same blocks.
 */
export function buildRunCard(input: RunCardInput): { blocks: unknown[]; text: string } {
  const title = truncate(input.title, CARD_TITLE_CAP) || "Run";
  const output = input.output?.trim();
  return {
    blocks: [
      {
        type: "task_card",
        task_id: "thread",
        title,
        status: input.status,
        details: richText(detailsText(input.model, input.repoSpecs)),
        ...(output ? { output: richText(truncate(output, RICH_TEXT_CAP)) } : {}),
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Open in UseAgent", emoji: true },
            url: input.webUrl,
            action_id: "open_in_useagent",
          },
        ],
      },
    ],
    text: title,
  };
}
