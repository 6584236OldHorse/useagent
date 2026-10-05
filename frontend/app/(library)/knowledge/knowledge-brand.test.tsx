import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { knowledgeFolderLabel, knowledgeItemForDisplay, seedFolders } from "./knowledge-data";
import { KnowledgeGallery } from "./knowledge-gallery";

test("keeps the persisted knowledge folder key while displaying UseAgent", () => {
  expect(seedFolders).toContain("useagent-app");
  expect(knowledgeFolderLabel("useagent-app")).toBe("UseAgent");
  expect(knowledgeFolderLabel("skynet-app")).toBe("UseAgent");
  expect(knowledgeFolderLabel("Engineering")).toBe("Engineering");
  const storedItem = {
    id: "knowledge-1",
    title: "Prefer semantic tokens",
    body: "Use the design system tokens.",
    folder: "skynet-app",
    updated: "now",
    pinned: false,
  };
  expect(knowledgeItemForDisplay(storedItem).folder).toBe("UseAgent");
  expect(storedItem.folder).toBe("skynet-app");

  const gallery = renderToStaticMarkup(
    <KnowledgeGallery initialLive initialError={false} initialItems={[storedItem]} />,
  );
  expect(gallery).toContain(">UseAgent<");
  expect(gallery).not.toContain(">skynet-app<");
});
