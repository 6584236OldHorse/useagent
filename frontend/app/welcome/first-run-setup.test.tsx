import { expect, test } from "bun:test";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { FirstRunSetup, invitationsFor, resolveFirstRun } from "./first-run-setup";

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

test("a first run renders from the workspace read alone; a failed invitations read leaves the page up, never a redirect: the loop between / and /welcome cannot form", async () => {
  const load = await resolveFirstRun(async () => [workspace]);
  expect(load).toEqual({ kind: "ready", workspace, invitations: undefined });
  // The page shows naming and the way on while invitations are still loading...
  const loading = render(load);
  expect(loading).toContain("Loading invitations");
  expect(loading).toContain("Save name");
  expect(loading).toContain("Continue to workspace");
  // ...and stays up with that section in an error state when their read fails.
  let reads = 0;
  expect(
    await invitationsFor("org-1", async () => {
      reads += 1;
      throw new Error("invitations 503");
    }),
  ).toBeNull();
  expect(reads).toBe(1);
  const failed = render({ kind: "ready", workspace, invitations: null });
  expect(failed).toContain("Could not load the invitations.");
  expect(failed).toContain("Continue to workspace");
  expect(failed).toContain("Save name");
});

test("a failed workspace read renders too, with a retry and a way on, instead of sending the person away", async () => {
  const load = await resolveFirstRun(async () => {
    throw new Error("workspaces 503");
  });
  expect(load).toEqual({ kind: "unavailable" });
  const html = render(load);
  expect(html).toContain("Could not load your workspace");
  expect(html).toContain("Try again");
  expect(html).toContain("Continue to workspace");
  expect(html).not.toContain("Save name");
});

test("only a workspace read that says so sends the person to the landing page", async () => {
  expect(await resolveFirstRun(async () => [{ ...workspace, defaultName: false }])).toEqual({ kind: "not-first-run" });
});

test("invitations answered for another workspace are dropped, not shown under this one", async () => {
  expect(await invitationsFor("org-1", async () => ({ organizationId: "org-2", invitations: [invitation] }))).toBeNull();
  expect(await invitationsFor("org-1", async () => ({ organizationId: "org-1", invitations: [invitation] }))).toEqual([invitation]);
});

test("the first-run page offers the workspace name, the invitations and a way on; no allowance, no provider choice", () => {
  const html = render({ kind: "ready", workspace, invitations: [invitation] });
  expect(html).toContain("Welcome to UseAgent");
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
