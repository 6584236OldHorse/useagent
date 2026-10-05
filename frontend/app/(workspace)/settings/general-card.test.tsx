import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GeneralCard } from "./general-card";

test("the General card shows the workspace's own name, as renamed, not a placeholder", () => {
  const html = renderToStaticMarkup(<GeneralCard initialWorkspaceName="Acme Robotics" />);
  expect(html).toContain("Workspace name");
  expect(html).toContain("Acme Robotics");
  expect(html).not.toContain(">UseAgent<");
});

test("while the workspace list loads the row shows nothing rather than a wrong name", () => {
  const html = renderToStaticMarkup(<GeneralCard />);
  expect(html).toContain("Workspace name");
  expect(html).not.toContain("Not set");
  expect(html).not.toContain(">UseAgent<");
});

import { activeWorkspaceName } from "./general-card";

test("a list without the session's workspace is a failed read, not an unset name", () => {
  expect(activeWorkspaceName([{ active: false, name: "Acme" }])).toBeNull();
  expect(activeWorkspaceName([])).toBeNull();
  expect(activeWorkspaceName([{ active: true, name: "Acme" }])).toBe("Acme");
});
