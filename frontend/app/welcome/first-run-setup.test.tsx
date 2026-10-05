import { expect, test } from "bun:test";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { FirstRunSetup } from "./first-run-setup";

const router = {
  push() {},
  replace() {},
  refresh() {},
  back() {},
  forward() {},
  prefetch() {},
} as unknown as AppRouterInstance;

function render(initial: Parameters<typeof FirstRunSetup>[0]["initial"]) {
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <FirstRunSetup initial={initial} />
    </AppRouterContext.Provider>,
  );
}

test("the first-run page offers the workspace name, the invitations and a way on; no allowance, no provider choice", () => {
  const html = render({
    workspace: {
      id: "org-1",
      name: "Priya's workspace",
      role: "owner",
      active: true,
      members: 1,
      defaultName: true,
    },
    invitations: [{ id: "inv-1", email: "dana@acme.com", role: "admin", expiresAt: "2026-09-20T10:00:00Z" }],
  });
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
