import { expect, test } from "bun:test";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { FirstRunSetup, resolveFirstRun } from "./first-run-setup";

const router = {
  push() {},
  replace() {},
  refresh() {},
  back() {},
  forward() {},
  prefetch() {},
} as unknown as AppRouterInstance;

const workspace = {
  id: "org-1",
  name: "Priya's workspace",
  role: "owner" as const,
  active: true,
  members: 1,
  defaultName: true,
};
const invitation = { id: "inv-1", email: "dana@acme.com", role: "admin" as const, expiresAt: "2026-09-20T10:00:00Z" };

function render(initial: Parameters<typeof FirstRunSetup>[0]["initial"]) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <FirstRunSetup initial={initial} />
    </AppRouterContext.Provider>,
  );
}

test("a first run with a failed invitations read renders the page, never a redirect: the loop between / and /welcome cannot form", async () => {
  let invitationReads = 0;
  const load = await resolveFirstRun({
    listWorkspaces: async () => [workspace],
    fetchInvitations: async () => {
      invitationReads += 1;
      throw new Error("invitations 503");
    },
  });
  expect(load).toEqual({ kind: "ready", workspace, invitations: null });
  expect(invitationReads).toBe(1);
  // The page it produces still offers the way on.
  const html = render(load);
  expect(html).toContain("Could not load the invitations.");
  expect(html).toContain("Continue to workspace");
  expect(html).toContain("Save name");
});

test("a failed workspace read renders too, with a retry and a way on, instead of sending the person away", async () => {
  const load = await resolveFirstRun({
    listWorkspaces: async () => {
      throw new Error("workspaces 503");
    },
    fetchInvitations: async () => ({ organizationId: "org-1", invitations: [] }),
  });
  expect(load).toEqual({ kind: "unavailable" });
  const html = render(load);
  expect(html).toContain("Could not load your workspace");
  expect(html).toContain("Try again");
  expect(html).toContain("Continue to workspace");
  expect(html).not.toContain("Save name");
});

test("only a workspace read that says so sends the person to the landing page", async () => {
  expect(
    await resolveFirstRun({
      listWorkspaces: async () => [{ ...workspace, defaultName: false }],
      fetchInvitations: async () => ({ organizationId: "org-1", invitations: [invitation] }),
    }),
  ).toEqual({ kind: "not-first-run" });
});

test("invitations answered for another workspace are dropped, not shown under this one", async () => {
  expect(
    await resolveFirstRun({
      listWorkspaces: async () => [workspace],
      fetchInvitations: async () => ({ organizationId: "org-2", invitations: [invitation] }),
    }),
  ).toEqual({ kind: "ready", workspace, invitations: null });
  expect(
    await resolveFirstRun({
      listWorkspaces: async () => [workspace],
      fetchInvitations: async () => ({ organizationId: "org-1", invitations: [invitation] }),
    }),
  ).toEqual({ kind: "ready", workspace, invitations: [invitation] });
});

test("the first-run page offers the workspace name, the invitations and a way on; no allowance, no provider choice", () => {
  const html = render({ kind: "ready", workspace, invitations: [invitation] });
  expect(html).toContain("Welcome to useAgent");
  expect(html).toContain('value="Priya&#x27;s workspace"');
  expect(html).toContain("Save name");
  expect(html).toContain("Invite a teammate");
  expect(html).toContain("dana@acme.com");
  expect(html).toContain("Admin, invited");
  expect(html).toContain("Continue to workspace");
  expect(html).not.toMatch(/allowance|sandbox provider/i);
});

test("while the answer is unknown the page waits instead of showing a form", () => {
  const html = render(undefined);
  expect(html).toContain("Preparing your workspace");
  expect(html).not.toContain("Save name");
});
