import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Turn } from "./conversation";
import { ConversationComposer } from "./conversation-composer";
import type { ApiRun } from "./types";

// The status tab over the reply composer: where the thread's newest run
// executes comes first and is there on an empty thread; the branch and the
// project join it once the thread has a repository. Absence is never printed.

function turn(
  id: string,
  sandbox: { sandbox_id: string | null; sandbox_provider?: string; run_location?: "cloud" | "local" },
): Turn {
  const run = {
    id,
    org_id: null,
    user_id: null,
    prompt: `Message ${id}`,
    model: "claude-sonnet-5",
    engine: "opencode",
    status: "completed",
    summary: "Done.",
    duration_ms: null,
    parent_run_id: null,
    child_session: false,
    thread_id: "run-1",
    engine_session_id: null,
    repo: null,
    repos: [],
    repo_specs: [],
    resolved_resources: [],
    memory_scope: "org",
    skill_id: null,
    skill_version: null,
    skill_content_hash: null,
    uploads: [],
    created_at: "2026-09-13T09:00:00Z",
    updated_at: "2026-09-13T09:01:00Z",
    steps: [],
    ...sandbox,
  } as ApiRun;
  return { run, steps: [], status: "completed", summary: run.summary, live: false, liveText: "", liveReasoning: "" };
}

function render(
  turns: Turn[],
  repoRevisions?: Record<string, string | null>,
  state: { running?: boolean; onStop?: () => void } = {},
): string {
  return renderToStaticMarkup(
    <ConversationComposer
      turns={turns}
      defaultEngine="opencode"
      defaultModel="claude-sonnet-5"
      defaultMemoryScope="org"
      pendingReply={null}
      onReply={async () => {}}
      threadError={null}
      onDismissThreadError={() => {}}
      repoRevisions={repoRevisions}
      running={state.running}
      onStop={state.onStop}
    />,
  );
}

const tabOf = (html: string) => {
  const start = html.indexOf('data-testid="composer-status-tab"');
  return html.slice(start, html.indexOf("Conversation context", start));
};

test("an empty thread shows only where its run executes, never a repository placeholder", () => {
  const html = render([turn("run-1", { sandbox_id: "sbx-1", sandbox_provider: "daytona" })]);
  const tab = tabOf(html);
  // The tab reads Cloud, and a member is never told the vendor.
  expect(tab).toContain('title="Runs in the cloud"');
  expect(tab).toContain(">Cloud<");
  expect(tab).not.toContain("Daytona");
  expect(tab).not.toContain("No repository");
  expect(tab).not.toContain("Default branch");
  expect(tab).toContain(">OpenCode<");
});

test("a thread with a repository shows the location, then the branch, then the project", () => {
  const html = render(
    [turn("run-1", { sandbox_id: "sbx-1", sandbox_provider: "daytona" }), turn("run-2", { sandbox_id: "local:mac-1:box" })],
    { "acme/gateway": "rl-staging" },
  );
  const tab = tabOf(html);
  // The newest run decides the location: a local sandbox names the machine
  // (the person's own until the runner list names it), never the older run's
  // provider.
  const location = tab.indexOf("Runs on This Mac");
  const branch = tab.indexOf(">rl-staging<");
  const project = tab.indexOf(">gateway<");
  expect(location).toBeGreaterThan(-1);
  expect(branch).toBeGreaterThan(location);
  expect(project).toBeGreaterThan(branch);
  expect(tab).not.toContain("Daytona");
});

test("before any sandbox exists the tab reads the place the thread asked for", () => {
  const cloud = tabOf(render([turn("run-1", { sandbox_id: null, run_location: "cloud" })]));
  expect(cloud).toContain(">Cloud<");
  expect(cloud).toContain('title="Runs in the cloud"');
  const local = tabOf(render([turn("run-1", { sandbox_id: null, run_location: "local" })]));
  expect(local).toContain(">This Mac<");
  expect(local).toContain('title="Runs on This Mac"');
});

test("a released local sandbox still reads as the machine, never as the local provider's name", () => {
  const tab = tabOf(render([turn("run-1", { sandbox_id: null, sandbox_provider: "local" })]));
  expect(tab).toContain(">This Mac<");
  expect(tab).toContain('title="Runs on This Mac"');
  expect(tab).not.toContain("Local machine");
});

test("a thread whose run recorded no sandbox shows no location item", () => {
  const tab = tabOf(render([turn("run-1", { sandbox_id: null })]));
  expect(tab).not.toContain("Runs on");
  expect(tab).toContain(">OpenCode<");
});

test("the tray hangs under the input card in every state and does not move when a run starts", () => {
  const idle = render([turn("run-1", { sandbox_id: "sbx-1", sandbox_provider: "daytona" })]);
  const running = render(
    [{ ...turn("run-1", { sandbox_id: "sbx-1", sandbox_provider: "daytona" }), status: "running" }],
    undefined,
    { running: true, onStop: () => {} },
  );
  for (const html of [idle, running]) {
    const card = html.indexOf("rounded-[20px]");
    const tray = html.indexOf('data-testid="composer-status-tab"');
    expect(card).toBeGreaterThan(-1);
    expect(tray).toBeGreaterThan(card);
  }
  // The same tray markup in both states: nothing to jump.
  expect(tabOf(running)).toBe(tabOf(idle));
  // The running frame (footer, Stop) sits above the card, the tray stays under it.
  expect(running.indexOf('data-session-ui="running-footer"')).toBeLessThan(running.indexOf("rounded-[20px]"));
});
