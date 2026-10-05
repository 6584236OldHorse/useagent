import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GeneralCard } from "./general-card";

test("the General card shows the workspace's own name, as renamed, not a placeholder", () => {
  const html = renderToStaticMarkup(<GeneralCard initialWorkspaceName="Acme Robotics" />);
  expect(html).toContain("Workspace name");
  expect(html).toContain("Acme Robotics");
  expect(html).not.toContain(">useAgent<");
});

test("while the workspace list loads the row shows nothing rather than a wrong name", () => {
  const html = renderToStaticMarkup(<GeneralCard />);
  expect(html).toContain("Workspace name");
  expect(html).not.toContain("Not set");
  expect(html).not.toContain(">useAgent<");
});
