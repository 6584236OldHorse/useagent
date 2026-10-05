"use client";

import type { ClipboardEvent, DragEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { backendFetch } from "@/lib/backend-fetch";

/** What a composer tile shows for a file: the thumbnail for an image, one typed
 *  icon for the rest, the paperclip when the file is none of the known kinds. */
export type AttachmentKind =
  | "image"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "code"
  | "video"
  | "file";

export type RunUpload = {
  readonly localId: string;
  readonly id: string | null;
  readonly name: string;
  readonly sizeBytes: number;
  readonly status: "uploading" | "ready" | "error";
  readonly kind: AttachmentKind;
  /** Object URL of a picked image, the tile's thumbnail; released with the tile. */
  readonly previewUrl: string | null;
};

type UploadResponse = {
  upload?: { id?: unknown; name?: unknown; size_bytes?: unknown };
};

const MAX_FILES = 10;

const EXTENSIONS: Record<Exclude<AttachmentKind, "file">, string> = {
  image: "png jpg jpeg gif webp svg heic heif avif bmp tif tiff",
  video: "mp4 mov webm mkv m4v avi",
  spreadsheet: "csv tsv xls xlsx xlsm numbers ods",
  presentation: "ppt pptx key odp",
  document: "pdf doc docx md txt rtf pages odt",
  code: "ts tsx js jsx mjs cjs json yaml yml toml py rb go rs java kt swift c h cpp hpp cs php sh bash zsh css scss html htm sql xml",
};

const KIND_BY_EXTENSION = new Map(
  Object.entries(EXTENSIONS).flatMap(([kind, list]) =>
    list.split(" ").map((extension) => [extension, kind as AttachmentKind] as const),
  ),
);

/** The tile kind for a file: by extension first (a browser types `.ts` as
 *  video), then by the MIME type for names without a known extension. */
export function attachmentKind(name: string, contentType = ""): AttachmentKind {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  const byExtension = KIND_BY_EXTENSION.get(extension);
  if (byExtension) return byExtension;
  const mime = contentType.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime === "text/csv" || mime.includes("spreadsheet") || mime.includes("excel")) return "spreadsheet";
  if (mime.includes("presentation") || mime.includes("powerpoint")) return "presentation";
  if (mime === "application/pdf" || mime.includes("word") || mime.startsWith("text/")) return "document";
  return "file";
}

/** Frees a thumbnail's object URL once its tile is gone. */
export function releasePreview(upload: Pick<RunUpload, "previewUrl">) {
  if (upload.previewUrl) URL.revokeObjectURL(upload.previewUrl);
}

type FileSource = FileList | readonly File[];

/**
 * Drop and paste handlers for a composer surface: dropped files and pasted
 * files (a screenshot on the clipboard) join the uploads. A text paste and a
 * drag that carries no files pass through untouched.
 */
export function attachmentIntake(addFiles: (files: FileSource) => unknown) {
  return {
    onDragOver(event: Pick<DragEvent, "preventDefault" | "dataTransfer">) {
      if (event.dataTransfer.types.includes("Files")) event.preventDefault();
    },
    onDrop(event: Pick<DragEvent, "preventDefault" | "dataTransfer">) {
      if (event.dataTransfer.files.length === 0) return;
      event.preventDefault();
      void addFiles(event.dataTransfer.files);
    },
    onPaste(event: Pick<ClipboardEvent, "preventDefault" | "clipboardData">) {
      if (event.clipboardData.files.length === 0) return;
      event.preventDefault();
      void addFiles(event.clipboardData.files);
    },
  };
}

export function useRunUploads() {
  const [uploads, setUploads] = useState<RunUpload[]>([]);
  // Thumbnails still held when the composer unmounts (a thread switch) are released with it.
  const live = useRef<readonly RunUpload[]>([]);
  useEffect(() => {
    live.current = uploads;
  }, [uploads]);
  useEffect(() => () => live.current.forEach(releasePreview), []);

  const addFiles = async (files: FileSource) => {
    const available = Math.max(0, MAX_FILES - uploads.length);
    const selected = Array.from(files).slice(0, available);
    const pending = selected.map((file) => {
      const kind = attachmentKind(file.name, file.type);
      return {
        localId: crypto.randomUUID(),
        id: null,
        name: file.name,
        sizeBytes: file.size,
        status: "uploading" as const,
        kind,
        previewUrl: kind === "image" ? URL.createObjectURL(file) : null,
        file,
      };
    });
    setUploads((current) => [...current, ...pending.map(({ file: _file, ...item }) => item)]);
    await Promise.all(
      pending.map(async ({ file, ...item }) => {
        try {
          const form = new FormData();
          form.set("file", file);
          const response = await backendFetch("/api/uploads", { method: "POST", body: form });
          if (!response.ok) throw new Error(`upload failed (${response.status})`);
          const body = (await response.json()) as UploadResponse;
          const uploadId = body.upload?.id;
          if (typeof uploadId !== "string") throw new Error("upload id missing");
          setUploads((current) =>
            current.map((upload) =>
              upload.localId === item.localId
                ? { ...upload, id: uploadId, status: "ready" }
                : upload,
            ),
          );
        } catch {
          setUploads((current) =>
            current.map((upload) =>
              upload.localId === item.localId ? { ...upload, status: "error" } : upload,
            ),
          );
        }
      }),
    );
  };

  const remove = async (upload: RunUpload) => {
    releasePreview(upload);
    setUploads((current) => current.filter((item) => item.localId !== upload.localId));
    if (upload.id) {
      await backendFetch(`/api/uploads/${upload.id}`, { method: "DELETE" }).catch(() => {});
    }
  };

  return {
    uploads,
    readyIds: uploads.flatMap((upload) =>
      upload.status === "ready" && upload.id ? [upload.id] : [],
    ),
    blocked: uploads.some((upload) => upload.status !== "ready"),
    addFiles,
    remove,
    clearAccepted: () => {
      uploads.forEach(releasePreview);
      setUploads([]);
    },
  };
}
