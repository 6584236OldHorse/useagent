import { expect, test } from "bun:test";
import { Menu } from "react-aria-components";
import { renderToStaticMarkup } from "react-dom/server";
import { DropdownMenuItem } from "@/components/base/dropdown/dropdown";
import { WorkspaceRow, sortedWorkspaces } from "./user-menu";

test("the picker puts the workspace the session is in first, then the rest by name", () => {
  const rows = sortedWorkspaces([
    { id: "b", name: "Beta", role: "member", active: false },
    { id: "a", name: "Alpha", role: "admin", active: false },
    { id: "p", name: "Priya's workspace", role: "owner", active: true },
  ]);
  expect(rows.map((row) => row.id)).toEqual(["p", "a", "b"]);
});

test("each row names the workspace, the person's role in it, and marks the one the session is in", () => {
  const html = renderToStaticMarkup(
    <Menu aria-label="Account menu">
      <DropdownMenuItem id="p" textValue="Priya's workspace">
        <WorkspaceRow workspace={{ id: "p", name: "Priya's workspace", role: "owner", active: true }} />
      </DropdownMenuItem>
      <DropdownMenuItem id="a" textValue="Acme">
        <WorkspaceRow workspace={{ id: "a", name: "Acme", role: "member", active: false }} />
      </DropdownMenuItem>
    </Menu>,
  );
  expect(html).toContain("Priya&#x27;s workspace");
  expect(html).toContain(">Owner<");
  expect(html).toContain(">Member<");
  expect(html.match(/Selected/g)).toHaveLength(1);
  // The role sits beside its own workspace: after the first name, before the second.
  expect(html.indexOf("Priya")).toBeLessThan(html.indexOf(">Owner<"));
  expect(html.indexOf(">Owner<")).toBeLessThan(html.indexOf("Acme"));
});
