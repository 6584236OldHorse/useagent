/**
 * Pure card-builder tests: no I/O, no Slack, fixtures only. Asserts the Block Kit
 * SHAPE of the thread card (one task_card with status/title/details/output, then
 * the url button) and the title derivation, so a long title or a mention can
 * never get the card rejected as invalid_blocks or leak a raw Slack id.
 */
import { describe, expect, test } from "bun:test";
import type { RepoRef } from "../github/repo-ref";
import {
  buildRunCard,
  cardStatusFor,
  deriveTitle,
  sessionUrl,
  stripMentions,
  type RunCardInput,
} from "./card";

const ref = (repo: string, branch: string | null = null): RepoRef => ({ repo, branch });

/** The task_card block; typed loosely for assertions. */
function taskCard(blocks: unknown[]): any {
  return (blocks as any[]).find((b) => b?.type === "task_card");
}
/** The plain text inside a single-section rich_text object. */
function plain(rich: any): string {
  return rich.elements[0].elements[0].text;
}

const base: RunCardInput = {
  title: "Add a dark mode toggle",
  status: "in_progress",
  model: "claude-opus-5",
  repoSpecs: [],
  webUrl: "https://app.example.com/session/thread-1",
};

describe("sessionUrl", () => {
  test("joins origin + /session/ + threadId, trimming a trailing slash", () => {
    expect(sessionUrl("https://app.example.com", "t-9")).toBe("https://app.example.com/session/t-9");
    expect(sessionUrl("https://app.example.com/", "t-9")).toBe("https://app.example.com/session/t-9");
  });
});

describe("deriveTitle", () => {
  test("takes the first sentence of the first non-empty line", () => {
    expect(deriveTitle("\n\n  Build the thing  \nand more")).toBe("Build the thing");
    expect(deriveTitle("Add a dark mode toggle to settings. Ask me if the palette is unclear.")).toBe(
      "Add a dark mode toggle to settings",
    );
    expect(deriveTitle("Is the deploy green? Check staging too.")).toBe("Is the deploy green?");
  });
  test("a greeting too short to stand alone keeps the whole line", () => {
    expect(deriveTitle("Hi! Please add a dark mode toggle")).toBe("Hi! Please add a dark mode toggle");
  });
  test("caps a long line short and adds an ellipsis", () => {
    const title = deriveTitle("x".repeat(500));
    expect(title.length).toBeLessThanOrEqual(64);
    expect(title.endsWith("…")).toBe(true);
  });
  test("mention markup never reaches a title: labels stay, raw ids go", () => {
    expect(deriveTitle("<@U05RJACQ25B> ask <@U0DANA|dana> in <#C0GEN|general> <!here> about the plan")).toBe(
      "ask @dana in #general @here about the plan",
    );
  });
  test("the cap never leaves a lone surrogate before the ellipsis", () => {
    const title = deriveTitle(`${"a".repeat(62)}😀ZZ`);
    expect(title.isWellFormed()).toBe(true);
    expect(title.length).toBeLessThanOrEqual(64);
    expect(title.endsWith("…")).toBe(true);
    expect(taskCard(buildRunCard({ ...base, title: `${"t".repeat(146)}😀ZZ` }).blocks).title.isWellFormed()).toBe(true);
  });

  test("falls back to 'Run' for an empty prompt", () => {
    expect(deriveTitle("   \n  ")).toBe("Run");
    expect(deriveTitle("<@U05RJACQ25B>")).toBe("Run");
  });
});

describe("stripMentions", () => {
  test("labels stay, broadcasts keep their word, bare ids and the rest go", () => {
    expect(
      stripMentions("<@U1|dana> <#C1|general> <!channel> <!subteam^S1|@eng> <@U2> <#C2> <!date^1^{date}|x> done"),
    ).toBe("@dana #general @channel @eng done");
  });
});

describe("cardStatusFor", () => {
  test("a turn spins until it settles as a tick or an error glyph", () => {
    expect(cardStatusFor("queued")).toBe("in_progress");
    expect(cardStatusFor("running")).toBe("in_progress");
    expect(cardStatusFor("completed")).toBe("complete");
    expect(cardStatusFor("failed")).toBe("error");
  });
});

describe("buildRunCard shape", () => {
  test("one task_card on the short title, then the button - nothing else", () => {
    const { blocks } = buildRunCard(base);
    expect((blocks as any[]).map((b) => b.type)).toEqual(["task_card", "actions"]);
    expect(taskCard(blocks)).toMatchObject({ task_id: "thread", title: "Add a dark mode toggle", status: "in_progress" });
    // No phase label, no Model row, no working line, no divider, no answer.
    expect(JSON.stringify(blocks)).not.toContain("Model:");
    expect(JSON.stringify(blocks)).not.toContain("Running");
  });

  test("details fold the model, the first repo with its branch and +N more behind the chevron", () => {
    const { blocks } = buildRunCard({
      ...base,
      repoSpecs: [ref("loop/backend", "main"), ref("loop/frontend"), ref("loop/infra", "deploy")],
    });
    const details = taskCard(blocks).details;
    expect(details.type).toBe("rich_text");
    expect(plain(details)).toBe("claude-opus-5 · loop/backend · main  +2 more");
  });

  test("no repos: the details are the model alone", () => {
    expect(plain(taskCard(buildRunCard(base).blocks).details)).toBe("claude-opus-5");
  });

  test("the output is the current verb while a turn runs and absent once it settles", () => {
    expect(plain(taskCard(buildRunCard({ ...base, output: "Searched the web" }).blocks).output)).toBe("Searched the web");
    expect(taskCard(buildRunCard({ ...base, status: "complete" }).blocks).output).toBeUndefined();
    expect(taskCard(buildRunCard({ ...base, output: "  " }).blocks).output).toBeUndefined();
  });

  test("the status is the card's own glyph", () => {
    expect(taskCard(buildRunCard({ ...base, status: "complete" }).blocks).status).toBe("complete");
    expect(taskCard(buildRunCard({ ...base, status: "error" }).blocks).status).toBe("error");
  });

  test("the actions block has an 'Open in useAgent' url button", () => {
    const { blocks } = buildRunCard(base);
    const button = (blocks as any[])[1].elements[0];
    expect(button.type).toBe("button");
    expect(button.text.text).toBe("Open in useAgent");
    expect(button.action_id).toBe("open_in_useagent");
    expect(button.url).toBe("https://app.example.com/session/thread-1");
  });

  test("the notification text is the title alone, with no em dash", () => {
    const { text } = buildRunCard({ ...base, status: "complete", repoSpecs: [ref("a/b")] });
    expect(text).toBe("Add a dark mode toggle");
    expect(text).not.toContain("—");
  });

  test("a very long title is capped under the plain-text limit", () => {
    const card = taskCard(buildRunCard({ ...base, title: "t".repeat(400) }).blocks);
    expect(card.title.length).toBeLessThanOrEqual(148);
    expect(card.title.endsWith("…")).toBe(true);
  });
});
