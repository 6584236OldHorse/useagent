import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Conversation, type Turn } from "./conversation";
import type { ApiRun, EngineId, PermissionMode } from "./types";

// The permission mode on replay: every settled user message carries the tag
// for the mode its run was started with, and the reply composer's chip starts
// on the thread's newest mode so the next turn keeps it unless changed.

function turn(id: string, permissionMode?: PermissionMode): Turn {
  const run: ApiRun = {
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
    sandbox_id: null,
    repo: null,
    repos: [],
    repo_specs: [],
    resolved_resources: [],
    memory_scope: "org",
    ...(permissionMode ? { permission_mode: permissionMode } : {}),
    skill_id: null,
    skill_version: null,
    skill_content_hash: null,
    uploads: [],
    created_at: "2026-09-13T09:00:00Z",
    updated_at: "2026-09-13T09:01:00Z",
    steps: [],
  };
  return { run, steps: [], status: "completed", summary: run.summary, live: false, liveText: "", liveReasoning: "" };
}

function render(turns: Turn[], defaultEngine: EngineId = "opencode"): string {
  return renderToStaticMarkup(
    <Conversation
      turns={turns}
      defaultEngine={defaultEngine}
      defaultModel="claude-sonnet-5"
      defaultMemoryScope="org"
      pendingReply={null}
      onReply={async () => {}}
    />,
  );
}

test("every replayed message shows the mode its run was started with, and the composer chip starts on the newest", () => {
  const html = render([turn("run-1", "read-only"), turn("run-2", "auto-accept-edits")]);
  const first = html.slice(html.indexOf('data-run-id="run-1"'), html.indexOf('data-run-id="run-2"'));
  const second = html.slice(html.indexOf('data-run-id="run-2"'));
  expect(first).toContain('data-testid="permission-mode-tag"');
  expect(first).toContain("Read only");
  expect(second).toContain("Guard, edits auto-applied");
  expect(html.match(/data-testid="permission-mode-tag"/g)).toHaveLength(2);
  expect(html).toContain('aria-label="Permission: Guard"');
});

test("a run that reported no mode shows no tag, and the composer chip reads full access", () => {
  const html = render([turn("run-1")]);
  expect(html).not.toContain('data-testid="permission-mode-tag"');
  expect(html).toContain('aria-label="Permission: Full access"');
});

test("on an engine that cannot ask first the reply composer's chip reads Full access, whatever the newest turn ran with", () => {
  const html = render([turn("run-1", "read-only")], "pi");
  expect(html).toContain('aria-label="Permission: Full access"');
  expect(html).not.toContain('aria-label="Permission: Read only"');
});
