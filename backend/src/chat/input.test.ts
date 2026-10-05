import { describe, expect, test } from "bun:test";
import {
  preflightChatUploads,
  SafeChatInputError,
  type ChatUploadMetadata,
} from "./input";

const MIB = 1024 * 1024;

function upload(overrides: Partial<ChatUploadMetadata> = {}): ChatUploadMetadata {
  const sha256 = "a".repeat(64);
  return {
    name: "image.png",
    contentType: "image/png",
    sizeBytes: 1,
    sha256,
    storageKey: sha256,
    ...overrides,
  };
}

function code(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SafeChatInputError);
    return (error as SafeChatInputError).code;
  }
  return undefined;
}

describe("chat attachment metadata preflight", () => {
  test("accepts supported image and plain-text attachments", () => {
    expect(preflightChatUploads([
      upload(),
      upload({ name: "notes.md", contentType: "text/markdown", sizeBytes: 100 }),
      upload({ name: "notes.txt", contentType: "text/plain", sizeBytes: 100 }),
    ])).toEqual(["image", "text", "text"]);
  });

  test("rejects unsupported types, bad integrity metadata, and product cap violations", () => {
    expect(code(() => preflightChatUploads([upload({ name: "report.pdf", contentType: "application/pdf" })])))
      .toBe("attachment_type_unsupported");
    expect(code(() => preflightChatUploads([upload({ storageKey: "b".repeat(64) })])))
      .toBe("attachment_integrity_failed");
    expect(code(() => preflightChatUploads(Array.from({ length: 11 }, () => upload()))))
      .toBe("attachment_count_exceeded");
    expect(code(() => preflightChatUploads([upload({ sizeBytes: 5 * MIB + 1 })])))
      .toBe("attachment_image_too_large");
    expect(code(() => preflightChatUploads([
      upload({ sizeBytes: 5 * MIB }),
      upload({ sizeBytes: 5 * MIB }),
      upload({ sizeBytes: 1 }),
    ]))).toBe("attachment_image_budget_exceeded");
    expect(code(() => preflightChatUploads([
      upload({ name: "a.txt", contentType: "text/plain", sizeBytes: 64 * 1024 + 1 }),
      upload({ name: "b.md", contentType: "text/markdown", sizeBytes: 64 * 1024 }),
    ]))).toBe("attachment_text_budget_exceeded");
  });
});
