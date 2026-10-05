// Public stand-in for a component the private edition draws with a licensed UI kit.
// Same exports and props, written from scratch for the open-source build.
"use client";

import { RiArrowDownSLine, RiCheckLine, RiLock2Line, RiSearchLine } from "@remixicon/react";
import { type ComponentType, type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Focusable,
  Menu as AriaMenu,
  Popover as AriaPopover,
} from "react-aria-components";
import { commandSubstringFilter } from "@/components/base/command/command";
import { DropdownMenuItem } from "@/components/base/dropdown/dropdown";
import { MENU_ITEMS_CONTAINER, MENU_POPOVER_SURFACE } from "@/components/base/dropdown/menu-styles";
import { useOverlayPortalContainer } from "@/components/base/overlay-portal-container";
import { RadioDot } from "@/components/base/radio/radio";
import { Tooltip, TooltipTrigger } from "@/components/base/tooltip/tooltip";
import { type MarkProps, vendorMarkForModel } from "@/components/foundations/icons/vendor-marks";
import { cx } from "@/utils/cx";
import { useDismissOnOutsidePress, useTriggerToggle } from "@/utils/use-dismiss-on-outside-press";

type MarkComponent = ComponentType<MarkProps>;

export interface ModelPickerRow {
  readonly value: string;
  readonly label: string;
  /** One line under the label (a discovered row's reason). */
  readonly description?: string;
  readonly disabled?: boolean;
  /** The reasoning levels this model's engine offers, ascending; absent or
   *  empty draws no effort selector. */
  readonly efforts?: readonly string[];
  /** The level the runtime uses when the run carries none. */
  readonly defaultEffort?: string;
  /** A row the member cannot run yet: the tag says what it needs and picking
   *  it calls `onUnlock` instead of selecting it. */
  readonly unlock?: { readonly label: string; readonly onUnlock: () => void };
}

/** A level in sentence case: "xhigh" reads "Extra high", the rest capitalised. */
export function effortLabel(effort: string): string {
  if (effort === "xhigh") return "Extra high";
  return effort.charAt(0).toUpperCase() + effort.slice(1);
}

/** The level `row` shows for the run's `effort`: the chosen one when the row
 *  offers it, else the row's default (its first level without one); null when
 *  the row offers no levels. */
export function rowEffort(row: ModelPickerRow, effort: string | null | undefined): string | null {
  const efforts = row.efforts ?? [];
  if (efforts.length === 0) return null;
  if (effort && efforts.includes(effort)) return effort;
  return row.defaultEffort ?? efforts[0] ?? null;
}

/** The level a freshly picked row shows ("" when it offers none). */
export function effortAfterPick(
  providers: readonly ModelPickerProvider[],
  modelId: string,
  providerId: string,
  effort: string | null | undefined,
): string {
  const row = findPickerRow(providers, modelId, providerId)?.row;
  return row ? (rowEffort(row, effort) ?? "") : "";
}

/** A pick: a locked row hands off to its unlock action; any other row selects
 *  and carries the level it will show. */
export function applyPick(
  providers: readonly ModelPickerProvider[],
  modelId: string,
  providerId: string,
  effort: string | null | undefined,
  onChange: (modelId: string, providerId: string) => void,
  onEffortChange?: (effort: string) => void,
): void {
  const unlock = findPickerRow(providers, modelId, providerId)?.row.unlock;
  if (unlock) {
    unlock.onUnlock();
    return;
  }
  onChange(modelId, providerId);
  onEffortChange?.(effortAfterPick(providers, modelId, providerId, effort));
}

export interface ModelPickerSection {
  /** The heading over the rows; empty draws none (the plain lineup follows
   *  the panel's own Models title). */
  readonly label: string;
  /** Trailing affordance on the section heading (the Free-lane refresh). */
  readonly action?: ReactNode;
  /** One line under the heading that tells the member what the section needs. */
  readonly note?: ReactNode;
  /** An action after the note (add a key); it hands off to the page, so using
   *  it closes the picker. */
  readonly noteAction?: { readonly label: string; readonly onAction: () => void };
  readonly rows: readonly ModelPickerRow[];
}

export interface ModelPickerProvider {
  readonly id: string;
  readonly label: string;
  /** Second line in the rail entry's title (the runtime caption). */
  readonly caption?: string;
  readonly mark: MarkComponent;
  /** Trailing affordance in the panel header (the native catalog refresh). */
  readonly action?: ReactNode;
  readonly sections: readonly ModelPickerSection[];
}

export interface ModelPickerProps {
  readonly providers: readonly ModelPickerProvider[];
  /** The selected model id. */
  readonly value: string;
  /** The provider the selection belongs to, when one id can appear under two
   *  providers (an engine rail); the first provider carrying the id otherwise. */
  readonly providerId?: string;
  readonly onChange: (modelId: string, providerId: string) => void;
  /** A one-line notice above the rows (catalog staleness). */
  readonly notice?: string | null;
  /** The run's reasoning effort; the selected row shows it when its engine
   *  offers levels. Null shows the model's default. */
  readonly effort?: string | null;
  /** The chip's level after a menu pick, and after a model pick the level the
   *  new row shows ("" when it offers none), so the sent value never differs
   *  from the shown one. */
  readonly onEffortChange?: (effort: string) => void;
  readonly placement?: "top end" | "bottom end";
  readonly className?: string;
}

interface Match {
  readonly provider: ModelPickerProvider;
  readonly row: ModelPickerRow;
}

function rowsOf(providers: readonly ModelPickerProvider[]): Match[] {
  return providers.flatMap((provider) =>
    provider.sections.flatMap((section) => section.rows.map((row) => ({ provider, row }))),
  );
}

/** The row for `modelId`, under `providerId` when that provider carries it,
 *  else under the first provider that does. */
export function findPickerRow(
  providers: readonly ModelPickerProvider[],
  modelId: string,
  providerId?: string,
): Match | null {
  const matches = rowsOf(providers).filter((match) => match.row.value === modelId);
  return matches.find((match) => match.provider.id === providerId) ?? matches[0] ?? null;
}

/** Every provider's rows whose label or id contains `query`, in rail order. */
export function searchPickerRows(
  providers: readonly ModelPickerProvider[],
  query: string,
): Match[] {
  return rowsOf(providers).filter(({ row }) => commandSubstringFilter(row.value, query, [row.label]) > 0);
}

/** Roving focus inside a rail or a row group: arrows wrap, Home and End reach
 *  the ends; null for any other key or an empty group. */
export function nextFocusIndex(key: string, current: number, count: number): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** Moves focus between the enabled `role` items under the handler's element;
 *  returns the index focused, or null when the key is not a move. */
function moveFocus(event: KeyboardEvent<HTMLElement>, role: "tab" | "radio"): number | null {
  const target = event.target as HTMLElement;
  if (target.getAttribute("role") !== role) return null;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>(`[role="${role}"]:not(:disabled)`)];
  const next = nextFocusIndex(event.key, items.indexOf(target), items.length);
  if (next === null) return null;
  event.preventDefault();
  items[next]?.focus();
  return next;
}

const HEADING = "flex min-h-6 items-center justify-between gap-2 px-2 text-caption-1-medium text-text-tertiary";

export interface ModelPickerPanelProps
  extends Pick<
    ModelPickerProps,
    "providers" | "value" | "providerId" | "notice" | "effort" | "onEffortChange"
  > {
  /** The effort menu's popover, so the picker keeps open for a press inside it. */
  readonly effortPopoverRef?: RefObject<HTMLElement | null>;
  /** The rail entry being browsed; null shows the selection's provider. */
  readonly browsing: string | null;
  readonly onBrowse: (providerId: string) => void;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly onPick: (modelId: string, providerId: string) => void;
  /** A section's note action was used. */
  readonly onNoteAction?: () => void;
}

/** The picker's body: the provider rail, quick search, and the browsed
 *  provider's sections (or every provider's matches while searching). */
export function ModelPickerPanel({
  providers,
  value,
  providerId,
  notice,
  effort,
  onEffortChange,
  effortPopoverRef,
  browsing,
  onBrowse,
  query,
  onQueryChange,
  onPick,
  onNoteAction,
}: ModelPickerPanelProps) {
  const rowsRef = useRef<HTMLDivElement>(null);
  const selected = findPickerRow(providers, value, providerId);
  const shownId = browsing ?? selected?.provider.id ?? providerId;
  const shown = providers.find((provider) => provider.id === shownId) ?? providers[0];
  const searching = query.trim() !== "";
  // Searching lists every provider's matches as one headless group; browsing
  // lists the shown provider's sections, skipping empty ones.
  const groups: { section: ModelPickerSection | null; matches: Match[] }[] = searching
    ? [{ section: null, matches: searchPickerRows(providers, query) }]
    : shown
      ? shown.sections
          .filter((section) => section.rows.length > 0)
          .map((section) => ({ section, matches: section.rows.map((row) => ({ provider: shown, row })) }))
      : [];
  const matches = groups.flatMap((group) => group.matches);
  const isChecked = ({ provider, row }: Match) =>
    selected?.provider.id === provider.id && selected.row.value === row.value;
  // One tab stop for the group: the checked row, else the first enabled one.
  const tabStop = matches.find((match) => isChecked(match) && !match.row.disabled) ?? matches.find((match) => !match.row.disabled);

  // Open on the selection, not the top of a long lineup.
  useEffect(() => {
    rowsRef.current?.querySelector('[aria-checked="true"]')?.scrollIntoView({ block: "nearest" });
  }, []);

  return (
    <div className="flex max-h-[min(28rem,70vh)] w-[min(26rem,calc(100vw-48px))] min-h-0">
      <div
        role="tablist"
        aria-label="Providers"
        aria-orientation="vertical"
        className="flex shrink-0 flex-col gap-1 overflow-y-auto border-r border-border-button-default pr-1.5"
        onKeyDown={(event) => {
          const next = moveFocus(event, "tab");
          const provider = next === null ? undefined : providers[next];
          if (provider) onBrowse(provider.id);
        }}
      >
        {providers.map((provider) => {
          const Mark = provider.mark;
          const active = provider.id === shown?.id;
          return (
            <TooltipTrigger key={provider.id}>
              <Focusable>
                <button
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-label={provider.label}
                  tabIndex={active ? 0 : -1}
                  onClick={() => onBrowse(provider.id)}
                  className={cx(
                    "flex size-8 shrink-0 items-center justify-center rounded-lg text-text-secondary outline-none transition-colors",
                    "hover:bg-dropdown-item-hover-background hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                    active && "bg-dropdown-item-hover-background text-text-primary",
                  )}
                >
                  <Mark aria-hidden className="size-4" />
                </button>
              </Focusable>
              <Tooltip placement="right">
                <span className="block">{provider.label}</span>
                {provider.caption ? <span className="block text-text-tertiary">{provider.caption}</span> : null}
              </Tooltip>
            </TooltipTrigger>
          );
        })}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col pl-1.5">
        <div className="mb-1 flex h-8 shrink-0 items-center gap-2 border-b border-border-button-default px-2">
          <RiSearchLine aria-hidden className="size-4 shrink-0 text-text-tertiary" />
          <input
            // The popover does not trap focus, so the search claims it on open.
            ref={(node) => node?.focus()}
            type="text"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown") return;
              event.preventDefault();
              rowsRef.current?.querySelector<HTMLElement>('[role="radio"][tabindex="0"]')?.focus();
            }}
            placeholder="Quick search"
            aria-label="Search models"
            className="h-full min-w-0 flex-1 bg-transparent text-body-2-medium text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </div>

        <div className={HEADING}>
          <span>Models</span>
          {searching ? null : shown?.action}
        </div>
        {notice ? (
          <p className="mx-2 my-1 rounded-lg bg-background-secondary-default px-2 py-1.5 text-caption-1-regular text-text-secondary">
            {notice}
          </p>
        ) : null}

        {matches.length === 0 ? (
          <p className="px-2 py-2 text-body-2-medium text-text-tertiary">
            {searching ? "No models match" : "No models available"}
          </p>
        ) : (
          <div
            ref={rowsRef}
            role="radiogroup"
            aria-label={searching ? "Matching models" : `${shown?.label} models`}
            className="flex min-h-0 flex-col gap-0.5 overflow-y-auto overscroll-contain"
            onKeyDown={(event) => moveFocus(event, "radio")}
          >
            {groups.map(({ section, matches: rows }, index) => (
              <div key={section?.label || index} className="flex flex-col gap-0.5">
                {section?.label ? (
                  <div className={cx(HEADING, "pt-1.5")}>
                    <span>{section.label}</span>
                    {section.action}
                  </div>
                ) : null}
                {section?.note || section?.noteAction ? (
                  <p className="px-2 pb-1 text-caption-1-regular text-text-tertiary">
                    {section.note}
                    {section.noteAction ? (
                      <>
                        {" "}
                        <button
                          type="button"
                          className="text-text-secondary underline underline-offset-2 hover:text-text-primary"
                          onClick={() => {
                            section.noteAction?.onAction();
                            onNoteAction?.();
                          }}
                        >
                          {section.noteAction.label}
                        </button>
                      </>
                    ) : null}
                  </p>
                ) : null}
                {rows.map((match) => (
                  <PickerRow
                    key={`${match.provider.id}:${match.row.value}`}
                    match={match}
                    checked={isChecked(match)}
                    tabbable={match === tabStop}
                    showProvider={searching}
                    effort={effort}
                    onEffortChange={onEffortChange}
                    effortPopoverRef={effortPopoverRef}
                    onPick={onPick}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PickerRow({
  match: { provider, row },
  checked,
  tabbable,
  showProvider,
  effort,
  onEffortChange,
  effortPopoverRef,
  onPick,
}: {
  match: Match;
  checked: boolean;
  tabbable: boolean;
  showProvider: boolean;
  effort: string | null | undefined;
  onEffortChange: ((effort: string) => void) | undefined;
  effortPopoverRef: RefObject<HTMLElement | null> | undefined;
  onPick: (modelId: string, providerId: string) => void;
}) {
  const level = checked ? rowEffort(row, effort) : null;
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        aria-label={`${provider.label} ${row.label}${row.unlock ? `, ${row.unlock.label}` : ""}`}
        title={row.description ? `${row.label}: ${row.description}` : undefined}
        disabled={row.disabled}
        tabIndex={tabbable ? 0 : -1}
        onClick={() => onPick(row.value, provider.id)}
        className={cx(
          "flex min-w-0 flex-1 items-center gap-2 rounded-2lg px-2 py-1.5 text-left text-body-2-medium text-text-primary outline-none transition-colors",
          "hover:bg-dropdown-item-hover-background focus-visible:bg-dropdown-item-hover-background focus-visible:ring-2 focus-visible:ring-border-focus-ring",
          "disabled:cursor-not-allowed disabled:text-text-tertiary disabled:hover:bg-transparent",
        )}
      >
        {row.unlock ? (
          <RiLock2Line aria-hidden className="size-3.5 shrink-0 text-text-tertiary" />
        ) : (
          <RadioDot selected={checked} />
        )}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{row.label}</span>
          {row.description ? (
            <span className="truncate text-caption-1-regular text-text-tertiary">{row.description}</span>
          ) : null}
        </span>
        {showProvider ? <span className="shrink-0 text-caption-1-regular text-text-tertiary">{provider.label}</span> : null}
        {row.unlock ? (
          <span className="shrink-0 rounded-md bg-background-tertiary-default px-1.5 py-0.5 text-caption-1-medium text-text-secondary">
            {row.unlock.label}
          </span>
        ) : null}
      </button>
      {level ? (
        <EffortMenu
          efforts={row.efforts ?? []}
          level={level}
          onChange={onEffortChange}
          popoverRef={effortPopoverRef}
        />
      ) : null}
    </div>
  );
}

/** The selected row's level chip and its menu of the levels the model offers. */
function EffortMenu({
  efforts,
  level,
  onChange,
  popoverRef,
}: {
  efforts: readonly string[];
  level: string;
  onChange: ((effort: string) => void) | undefined;
  popoverRef: RefObject<HTMLElement | null> | undefined;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const ownPopoverRef = useRef<HTMLElement>(null);
  const menuPopoverRef = popoverRef ?? ownPopoverRef;
  const portalContainer = useOverlayPortalContainer();
  useDismissOnOutsidePress(isOpen, () => setIsOpen(false), [triggerRef, menuPopoverRef]);
  const allowOpenChange = useTriggerToggle(isOpen, triggerRef);
  return (
    <AriaDialogTrigger isOpen={isOpen} onOpenChange={(open) => allowOpenChange(open) && setIsOpen(open)}>
      <AriaButton
        ref={triggerRef}
        aria-label={`Effort: ${effortLabel(level)}`}
        isDisabled={!onChange}
        className={cx(
          "flex h-7 shrink-0 cursor-pointer items-center gap-0.5 rounded-lg border border-border-button-default px-2 text-caption-1-medium text-text-secondary outline-none transition-colors",
          "hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:cursor-default",
        )}
      >
        {effortLabel(level)}
        <RiArrowDownSLine aria-hidden className="size-3.5" />
      </AriaButton>
      <AriaPopover
        ref={menuPopoverRef}
        isNonModal
        UNSTABLE_portalContainer={portalContainer}
        placement="bottom end"
        offset={4}
        className={cx("w-40", MENU_POPOVER_SURFACE)}
      >
        <AriaMenu
          aria-label="Reasoning effort"
          autoFocus="first"
          selectionMode="single"
          selectedKeys={[level]}
          onAction={(key) => onChange?.(String(key))}
          onClose={() => setIsOpen(false)}
          className={MENU_ITEMS_CONTAINER}
        >
          {efforts.map((option) => (
            <DropdownMenuItem key={option} id={option} textValue={effortLabel(option)}>
              <span className="flex-1">{effortLabel(option)}</span>
              {option === level ? <RiCheckLine aria-hidden className="size-4 text-text-secondary" /> : null}
            </DropdownMenuItem>
          ))}
        </AriaMenu>
      </AriaPopover>
    </AriaDialogTrigger>
  );
}

/** The model chip and its picker popover. */
export function ModelPicker({
  providers,
  value,
  providerId,
  onChange,
  notice,
  effort,
  onEffortChange,
  placement = "top end",
  className,
}: ModelPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const effortPopoverRef = useRef<HTMLElement>(null);
  const portalContainer = useOverlayPortalContainer();
  const setOpen = (open: boolean) => {
    // Reset on open, not close, so the exit animation keeps its content.
    if (open) {
      setBrowsing(null);
      setQuery("");
    }
    setIsOpen(open);
  };
  useDismissOnOutsidePress(isOpen, () => setOpen(false), [triggerRef, popoverRef, effortPopoverRef]);
  const allowOpenChange = useTriggerToggle(isOpen, triggerRef);
  const label = findPickerRow(providers, value, providerId)?.row.label ?? value;
  const Mark = vendorMarkForModel(value);

  return (
    <AriaDialogTrigger isOpen={isOpen} onOpenChange={(open) => allowOpenChange(open) && setOpen(open)}>
      <AriaButton
        ref={triggerRef}
        data-testid="model-picker"
        aria-label={`Model: ${label}`}
        className={cx(
          "flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-body-2-medium text-text-secondary outline-none transition-colors",
          "hover:bg-dropdown-item-hover-background hover:text-text-primary focus-visible:ring-2 focus-visible:ring-border-focus-ring",
          className,
        )}
      >
        <Mark aria-hidden className="size-4 shrink-0" />
        <span className="truncate max-sm:sr-only">{label}</span>
        <RiArrowDownSLine aria-hidden className="size-4 shrink-0 text-text-tertiary" />
      </AriaButton>
      <AriaPopover
        ref={popoverRef}
        isNonModal
        UNSTABLE_portalContainer={portalContainer}
        placement={placement}
        offset={6}
        className={MENU_POPOVER_SURFACE}
      >
        <AriaDialog aria-label="Choose a model" className="outline-none">
          <ModelPickerPanel
            providers={providers}
            value={value}
            providerId={providerId}
            notice={notice}
            effort={effort}
            onEffortChange={onEffortChange}
            effortPopoverRef={effortPopoverRef}
            browsing={browsing}
            onBrowse={(id) => {
              setBrowsing(id);
              setQuery("");
            }}
            query={query}
            onQueryChange={setQuery}
            onPick={(modelId, pickedProviderId) => {
              applyPick(providers, modelId, pickedProviderId, effort, onChange, onEffortChange);
              setOpen(false);
            }}
            onNoteAction={() => setOpen(false)}
          />
        </AriaDialog>
      </AriaPopover>
    </AriaDialogTrigger>
  );
}
