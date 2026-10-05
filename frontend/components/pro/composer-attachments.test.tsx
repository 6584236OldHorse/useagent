import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunUpload } from "@/components/chat/run-uploads";
import {
  ComposerAddButton,
  ComposerAttachmentRow,
  ComposerAttachmentTile,
} from "./composer-attachments";

function upload(over: Partial<RunUpload> = {}): RunUpload {
  return {
    localId: "u1",
    id: "up-1",
    name: "shot.png",
    sizeBytes: 10,
    status: "ready",
    kind: "image",
    previewUrl: "blob:local/shot",
    ...over,
  };
}

const tile = (over: Partial<RunUpload> = {}) =>
  renderToStaticMarkup(<ComposerAttachmentTile upload={upload(over)} onRemove={() => {}} />);

describe("composer attachment tiles", () => {
  test("an image tile shows its thumbnail and a remove mark", () => {
    const html = tile();
    expect(html).toContain('data-attachment-kind="image"');
    expect(html).toContain('src="blob:local/shot"');
    expect(html).toContain('alt="shot.png"');
    expect(html).toContain('aria-label="Remove shot.png"');
  });

  test("typed files show their icon over the name; unknown ones the paperclip", () => {
    const cases: [RunUpload["kind"], string][] = [
      ["spreadsheet", "plugin-spreadsheets.svg"],
      ["presentation", "plugin-presentations.svg"],
      ["document", "plugin-documents.svg"],
      ["code", "plugin-codeblocks.svg"],
      ["video", "plugin-videos.svg"],
    ];
    for (const [kind, icon] of cases) {
      const html = tile({ kind, name: `a.${kind}`, previewUrl: null });
      expect(html).toContain(icon);
      expect(html).toContain(`>a.${kind}<`);
      expect(html).toContain(`aria-label="Remove a.${kind}"`);
    }
    const plain = tile({ kind: "file", name: "trace.zip", previewUrl: null });
    expect(plain).not.toContain("plugin-");
    expect(plain).toContain('data-attachment-kind="file"');
    expect(plain).toContain(">trace.zip<");
  });

  test("in flight and failed states are named", () => {
    expect(tile({ status: "uploading" })).toContain('aria-label="Uploading"');
    expect(tile({ status: "error" })).toContain('aria-label="Upload failed"');
    expect(tile()).not.toContain("Uploading");
  });
});

describe("composer attachment row", () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      upload({ localId: `u${i}`, name: `file-${i}.pdf`, kind: "document", previewUrl: null }),
    );
  const row = (uploads: RunUpload[]) =>
    renderToStaticMarkup(<ComposerAttachmentRow uploads={uploads} onRemove={() => {}} />);

  test("renders nothing without uploads", () => {
    expect(row([])).toBe("");
  });

  test("shows eight tiles and folds the rest behind a count", () => {
    const ten = row(many(10));
    expect(ten.match(/data-attachment-kind=/g)?.length).toBe(8);
    expect(ten).toContain('aria-label="Show 2 more attachments"');
    expect(ten).toContain(">+2<");
    const eight = row(many(8));
    expect(eight.match(/data-attachment-kind=/g)?.length).toBe(8);
    expect(eight).not.toContain("more attachments");
  });

  test("every tile carries its own remove control in one labelled list", () => {
    const html = row(many(3));
    expect(html).toContain('aria-label="Attached files"');
    for (const i of [0, 1, 2]) expect(html).toContain(`aria-label="Remove file-${i}.pdf"`);
  });
});

describe("composer add button", () => {
  test("is the menu trigger and reports its open state", () => {
    const closed = renderToStaticMarkup(
      <ComposerAddButton aria-label="Add context" open={false} onToggle={() => {}} />,
    );
    expect(closed).toContain('aria-label="Add context"');
    expect(closed).toContain('aria-haspopup="menu"');
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain("rounded-full");
    expect(closed).not.toContain("rotate-45");
    const open = renderToStaticMarkup(
      <ComposerAddButton aria-label="Add context" open onToggle={() => {}} />,
    );
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("rotate-45");
  });
});
