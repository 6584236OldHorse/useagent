import { describe, expect, test } from "bun:test";
import {
  attachmentIntake,
  attachmentKind,
  releasePreview,
  type RunUpload,
  withoutSent,
} from "./run-uploads";

describe("attachment kinds", () => {
  test("by extension, case-insensitive, before the browser's MIME guess", () => {
    expect(attachmentKind("Report.XLSX")).toBe("spreadsheet");
    expect(attachmentKind("deck.key")).toBe("presentation");
    expect(attachmentKind("notes.md", "text/markdown")).toBe("document");
    expect(attachmentKind("gateway.ts", "video/mp2t")).toBe("code");
    expect(attachmentKind("shot.PNG")).toBe("image");
    expect(attachmentKind("clip.mov")).toBe("video");
  });

  test("by MIME type when the extension says nothing", () => {
    expect(attachmentKind("photo", "image/heic")).toBe("image");
    expect(attachmentKind("export", "text/csv")).toBe("spreadsheet");
    expect(attachmentKind("slides", "application/vnd.ms-powerpoint")).toBe("presentation");
    expect(attachmentKind("paper", "application/pdf")).toBe("document");
  });

  test("anything else is a plain file", () => {
    expect(attachmentKind("trace.zip", "application/zip")).toBe("file");
    expect(attachmentKind("Makefile")).toBe("file");
    expect(attachmentKind("blob", "application/octet-stream")).toBe("file");
  });
});

describe("attachment intake", () => {
  const files = (n: number) =>
    Array.from({ length: n }, (_, i) => new File(["x"], `f${i}.png`)) as unknown as FileList;
  const drag = (types: string[], count: number) => {
    let prevented = false;
    const dataTransfer = { types, files: files(count), dropEffect: "" } as unknown as DataTransfer;
    return {
      event: {
        preventDefault: () => {
          prevented = true;
        },
        dataTransfer,
      },
      dataTransfer,
      prevented: () => prevented,
    };
  };

  test("a drop with files becomes uploads; a drag without files passes through", () => {
    const added: unknown[] = [];
    const intake = attachmentIntake((f) => added.push(f));
    const withFiles = drag(["Files"], 2);
    intake.onDragOver(withFiles.event);
    expect(withFiles.prevented()).toBe(true);
    expect(withFiles.dataTransfer.dropEffect).toBe("copy");
    intake.onDrop(withFiles.event);
    expect(added).toHaveLength(1);
    const text = drag(["text/plain"], 0);
    intake.onDragOver(text.event);
    intake.onDrop(text.event);
    expect(text.prevented()).toBe(false);
    expect(added).toHaveLength(1);
  });

  test("a pasted file becomes an upload; a text paste is left to the field", () => {
    const added: unknown[] = [];
    const intake = attachmentIntake((f) => added.push(f));
    let prevented = false;
    const paste = (count: number) => ({
      preventDefault: () => {
        prevented = true;
      },
      clipboardData: { files: files(count) } as unknown as DataTransfer,
    });
    intake.onPaste(paste(0));
    expect(prevented).toBe(false);
    expect(added).toHaveLength(0);
    intake.onPaste(paste(1));
    expect(prevented).toBe(true);
    expect(added).toHaveLength(1);
  });

  test("while a send is in flight a drop or paste is claimed but adds nothing", () => {
    // The request already carries the attachment ids; a file arriving now would
    // show as a tile and never be sent. The browser's default for an unclaimed
    // drop is to open the file, so the events are still consumed.
    const added: unknown[] = [];
    const intake = attachmentIntake((f) => added.push(f), false);
    const drop = drag(["Files"], 1);
    intake.onDragOver(drop.event);
    expect(drop.dataTransfer.dropEffect).toBe("none");
    intake.onDrop(drop.event);
    expect(drop.prevented()).toBe(true);
    let pastePrevented = false;
    intake.onPaste({
      preventDefault: () => {
        pastePrevented = true;
      },
      clipboardData: { files: files(1) } as unknown as DataTransfer,
    });
    expect(pastePrevented).toBe(true);
    expect(added).toHaveLength(0);
  });
});

describe("after a send", () => {
  const upload = (localId: string, id: string | null): RunUpload => ({
    localId,
    id,
    name: `${localId}.pdf`,
    sizeBytes: 1,
    status: id ? "ready" : "uploading",
    kind: "document",
    previewUrl: null,
    progress: id ? 100 : 10,
  });

  test("only the uploads the send carried leave; a later arrival stays for the next message", () => {
    const sentEarlier = upload("a", "up-a");
    const sentToo = upload("b", "up-b");
    const arrivedDuringSend = upload("c", "up-c");
    const stillUploading = upload("d", null);
    const kept = withoutSent([sentEarlier, sentToo, arrivedDuringSend, stillUploading], ["up-a", "up-b"]);
    expect(kept.map((item) => item.localId)).toEqual(["c", "d"]);
  });
});

describe("thumbnail release", () => {
  test("revokes the preview object URL and skips tiles without one", () => {
    const revoked: string[] = [];
    const original = URL.revokeObjectURL;
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
    try {
      releasePreview({ previewUrl: "blob:local/one" });
      releasePreview({ previewUrl: null });
    } finally {
      URL.revokeObjectURL = original;
    }
    expect(revoked).toEqual(["blob:local/one"]);
  });
});
