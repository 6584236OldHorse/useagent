"use client";

// The composer's attachment row: our upload records drawn with the BoardUI Pro
// Composer Panel tiles (composer-panel/composer-panel.tsx). A tile in flight
// carries its upload's progress ring, a landed one its remove mark, a failed
// one the warning mark.

import type { RunUpload } from "@/components/chat/run-uploads";
import {
  type ComposerAttachment,
  ComposerAttachmentStrip,
} from "@/components/pro/composer-panel/composer-panel";

/** The tile for an upload record. */
export function composerAttachment(upload: RunUpload): ComposerAttachment {
  return {
    id: upload.localId,
    name: upload.name,
    kind: upload.kind,
    ...(upload.previewUrl ? { src: upload.previewUrl } : {}),
    ...(upload.status === "uploading" ? { progress: upload.progress } : {}),
    ...(upload.status === "error" ? { failed: true } : {}),
  };
}

export function ComposerAttachmentRow({
  uploads,
  onRemove,
  className,
}: {
  uploads: readonly RunUpload[];
  onRemove: (upload: RunUpload) => void;
  className?: string;
}) {
  if (uploads.length === 0) return null;
  return (
    <ComposerAttachmentStrip
      attachments={uploads.map(composerAttachment)}
      onRemove={(id) => {
        const upload = uploads.find((item) => item.localId === id);
        if (upload) onRemove(upload);
      }}
      className={className}
    />
  );
}
