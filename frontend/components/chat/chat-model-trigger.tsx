"use client";

import { RiArrowDownSLine } from "@remixicon/react";
import type { ChatModelOption } from "@/components/chat/chat-model-menu";
import { cx as cn } from "@/utils/cx";

/** The Chat surface's model trigger: the selected model's tint and label, opening
 *  the "Choose model" card the composer renders above itself. */
export function ChatModelTrigger({
  open,
  option,
  fallback,
  onToggle,
}: {
  open: boolean;
  option: ChatModelOption | undefined;
  /** The raw model id shown while the option list has no entry for it. */
  fallback: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`Model: ${option?.label ?? fallback}`}
      onClick={onToggle}
      className={cn(
        "flex h-9 items-center gap-1.5 rounded-xl border px-2.5 text-body-2-medium transition-colors",
        open
          ? "border-border-button-default bg-background-secondary-default text-text-primary"
          : "border-border-button-default text-text-secondary hover:bg-background-primary-hover",
      )}
    >
      {option && (
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: option.color }}
          aria-hidden
        />
      )}
      <span className="max-w-[10rem] truncate">{option?.label ?? "Model"}</span>
      <RiArrowDownSLine className="size-4 shrink-0" aria-hidden />
    </button>
  );
}
