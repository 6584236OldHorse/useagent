"use client";

// BoardUI Pro "Composer Panel" attachments (licensed; not part of the public release).
// Adapted from the panel's attachment strip and the composer add menu's trigger: a
// 56px tile per file (an image shows its thumbnail, any other file its typed icon
// over the name) with the remove mark in its corner, the rest folded behind a
// count past eight, and the round add button that opens the composer's own
// add-context menu.

import { RiAddLine, RiAttachment2, RiErrorWarningLine, RiLoader4Line } from "@remixicon/react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { CloseButton } from "@/components/base/buttons/close-button";
import type { AttachmentKind, RunUpload } from "@/components/chat/run-uploads";
import { cx } from "@/utils/cx";

/** Tiles shown before the rest fold behind a count. */
export const VISIBLE_ATTACHMENTS = 8;

/** The plugin icons the add menu's Create rows already use, one per typed kind;
 *  an image shows its thumbnail and an unknown file the paperclip. */
const KIND_ICONS: Partial<Record<AttachmentKind, { src: string; darkSrc?: string }>> = {
  document: {
    src: "/plugin-icons/plugin-documents.svg",
    darkSrc: "/plugin-icons/plugin-documents-dark.svg",
  },
  spreadsheet: { src: "/plugin-icons/plugin-spreadsheets.svg" },
  presentation: { src: "/plugin-icons/plugin-presentations.svg" },
  code: { src: "/plugin-icons/plugin-codeblocks.svg" },
  video: { src: "/plugin-icons/plugin-videos.svg" },
};

const TILE =
  "relative size-14 shrink-0 rounded-xl border border-border-button-default bg-background-primary-default";

/** The round "+" at the footer's left; the composer owns the menu it opens. */
export function ComposerAddButton({
  open,
  onToggle,
  className,
  "aria-label": label,
}: {
  open: boolean;
  onToggle: () => void;
  className?: string;
  "aria-label": string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={onToggle}
      className={cx(
        "flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-ai-chat-composer-add-background p-2 outline-none transition-colors duration-150 hover:bg-ai-chat-composer-add-hover-background focus-visible:ring-2 focus-visible:ring-border-focus-ring",
        className,
      )}
    >
      <RiAddLine
        className={cx(
          "size-5 text-foreground-icon-primary transition-transform duration-200",
          open && "rotate-45",
        )}
        aria-hidden
      />
    </button>
  );
}

/** One 56px tile: the thumbnail for an image, otherwise the 24px typed icon with
 *  the file name underneath. In flight the content dims behind a spinner; a
 *  failed upload shows the warning mark. The remove mark sits top right. */
export function ComposerAttachmentTile({
  upload,
  onRemove,
}: {
  upload: RunUpload;
  onRemove: (upload: RunUpload) => void;
}) {
  const uploading = upload.status === "uploading";
  const failed = upload.status === "error";
  const thumbnail = upload.kind === "image" ? upload.previewUrl : null;
  const icon = KIND_ICONS[upload.kind];
  return (
    <div
      data-attachment-kind={upload.kind}
      data-status={upload.status}
      title={upload.name}
      className={cx(TILE, failed && "border-border-error-default")}
    >
      <div
        className={cx(
          "size-full transition-opacity duration-300",
          (uploading || failed) && "opacity-60",
        )}
      >
        {thumbnail ? (
          <img
            src={thumbnail}
            alt={upload.name}
            className="size-full rounded-[11px] object-cover"
          />
        ) : (
          <>
            {icon ? (
              <>
                <img
                  src={icon.src}
                  alt=""
                  width={24}
                  height={24}
                  aria-hidden
                  className={cx(
                    "absolute top-1 left-[3px] size-6",
                    icon.darkSrc && "theme-asset-light",
                  )}
                />
                {icon.darkSrc && (
                  <img
                    src={icon.darkSrc}
                    alt=""
                    width={24}
                    height={24}
                    aria-hidden
                    className="theme-asset-dark absolute top-1 left-[3px] size-6"
                  />
                )}
              </>
            ) : (
              <RiAttachment2
                className="absolute top-1.5 left-1.5 size-5 text-foreground-icon-secondary"
                aria-hidden
              />
            )}
            {/* 9px is the design's tile caption; no type token goes that small. */}
            <span className="absolute top-9 left-1.5 max-w-[44px] truncate text-[9px] leading-[15px] font-medium tracking-[0.2px] text-text-secondary">
              {upload.name}
            </span>
          </>
        )}
      </div>
      {uploading && (
        <RiLoader4Line
          role="img"
          aria-label="Uploading"
          className={cx(
            "absolute inset-0 m-auto size-4 animate-spin",
            thumbnail ? "text-white" : "text-text-secondary",
          )}
        />
      )}
      {failed && (
        <RiErrorWarningLine
          role="img"
          aria-label="Upload failed"
          className="absolute inset-0 m-auto size-4 text-text-error-primary"
        />
      )}
      <CloseButton
        size="2xs"
        aria-label={`Remove ${upload.name}`}
        onClick={() => onRemove(upload)}
        className={cx(
          "absolute top-[3px] right-[3px]",
          thumbnail && "bg-white/50 text-white backdrop-blur-[2px] hover:text-white",
        )}
      />
    </div>
  );
}

/** The tiles above the prompt, wrapping as they run out of width. Past
 *  `VISIBLE_ATTACHMENTS` the rest wait behind a "+N" tile until it is pressed. */
export function ComposerAttachmentRow({
  uploads,
  onRemove,
  className,
}: {
  uploads: readonly RunUpload[];
  onRemove: (upload: RunUpload) => void;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (uploads.length === 0) return null;
  const shown = expanded ? uploads : uploads.slice(0, VISIBLE_ATTACHMENTS);
  const hidden = uploads.length - shown.length;
  return (
    <ul aria-label="Attached files" className={cx("flex flex-wrap items-start gap-2", className)}>
      <AnimatePresence initial={false}>
        {shown.map((upload) => (
          <motion.li
            key={upload.localId}
            layout
            initial={{ opacity: 0, scale: 0.8, filter: "blur(4px)" }}
            animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
            exit={{ opacity: 0, scale: 0.8, filter: "blur(4px)" }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <ComposerAttachmentTile upload={upload} onRemove={onRemove} />
          </motion.li>
        ))}
      </AnimatePresence>
      {hidden > 0 && (
        <li>
          <button
            type="button"
            aria-label={`Show ${hidden} more attachments`}
            onClick={() => setExpanded(true)}
            className={cx(
              TILE,
              "grid cursor-pointer place-items-center text-body-2-medium text-text-secondary outline-none transition-colors hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring",
            )}
          >
            {`+${hidden}`}
          </button>
        </li>
      )}
    </ul>
  );
}
