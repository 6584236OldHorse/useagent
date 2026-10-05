// Public stand-in for a component the private edition draws with a licensed UI kit.
// Same exports and props, written from scratch for the open-source build.
"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Checkbox as AriaCheckbox } from "react-aria-components";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/base/buttons/button";
import { CloseButton } from "@/components/base/buttons/close-button";
import { CheckboxGlyph } from "@/components/base/checkbox/checkbox-glyph";
import { PillTab, PillTabList } from "@/components/base/tabs/pill-tab";
import { EASE_OUT } from "@/lib/motion";
import { cx } from "@/utils/cx";

export type QuestionnaireSelect = "single" | "multiple";
export type QuestionnaireOption = {
  value: string;
  label: ReactNode;
  description?: ReactNode;
};

export type QuestionnaireQuestion = {
  id: string;
  /** The question itself, shown across the top of the card. */
  question: string;
  /** Overrides the card-level `select` for this question. */
  select?: QuestionnaireSelect;
  options: QuestionnaireOption[];
  /** Adds a free-text "Other" row after the options; pass an object to reword it. */
  other?: boolean | { label?: string; placeholder?: string };
  /** Label for this question's step pill; "Step N" by default. */
  stepLabel?: string;
};

export type QuestionnaireAnswer = {
  /** Selected option values, in the question's option order. */
  values: string[];
  /** The free-text answer; present only while the "Other" row is selected. */
  other?: string;
};

export type QuestionnaireAnswers = Record<string, QuestionnaireAnswer>;
export interface QuestionnaireLabels {
  previous?: string;
  next?: string;
  /** Replaces Next on the last question. */
  complete?: string;
  other?: string;
  otherPlaceholder?: string;
}

export interface QuestionnaireProps {
  questions: QuestionnaireQuestion[];
  /** Selection mode for questions that do not set their own. */
  select?: QuestionnaireSelect;
  /** Zero-based index of the visible question (controlled). */
  step?: number;
  defaultStep?: number;
  onStepChange?: (step: number) => void;
  answers?: QuestionnaireAnswers;
  defaultAnswers?: QuestionnaireAnswers;
  onAnswersChange?: (answers: QuestionnaireAnswers) => void;
  /** Fires with every answer once the last question is answered. */
  onComplete?: (answers: QuestionnaireAnswers) => void;
  /** Shows the dismiss control in the corner and receives its press. */
  onDismiss?: () => void;
  /** How long a single-select pick stays visible before the next question slides in (ms). */
  advanceDelay?: number;
  labels?: QuestionnaireLabels;
  className?: string;
}

const NO_ANSWER: QuestionnaireAnswer = { values: [] };

const rowClass = (selected: boolean) =>
  cx(
    "flex w-full cursor-pointer items-start gap-3 rounded-xl border px-3 py-2.5 text-left outline-none",
    "transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-border-focus-ring",
    selected
      ? "border-border-button-active bg-background-tertiary-default"
      : "border-border-button-default hover:bg-background-primary-hover",
  );

/** The digit badge of a single-select row: its key hint, filled once picked. */
function Marker({ selected, children }: { selected: boolean; children?: ReactNode }) {
  return (
    <span
      aria-hidden
      className={cx(
        "mt-px flex size-[18px] shrink-0 items-center justify-center rounded-md border text-caption-1-medium tabular-nums",
        selected
          ? "border-transparent bg-accent-500 text-text-white"
          : "border-border-button-default text-text-tertiary",
      )}
    >
      {children}
    </span>
  );
}

function OptionText({ label, description }: { label: ReactNode; description?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="text-body-medium text-text-primary">{label}</span>
      {description && <span className="text-body-2-regular text-text-secondary">{description}</span>}
    </span>
  );
}

export function Questionnaire({
  questions,
  select = "multiple",
  step: stepProp,
  defaultStep = 0,
  onStepChange,
  answers: answersProp,
  defaultAnswers,
  onAnswersChange,
  onComplete,
  onDismiss,
  advanceDelay = 180,
  labels,
  className,
}: QuestionnaireProps) {
  const [ownStep, setOwnStep] = useState(defaultStep);
  const [ownAnswers, setOwnAnswers] = useState<QuestionnaireAnswers>(defaultAnswers ?? {});
  const rootRef = useRef<HTMLDivElement>(null);
  const otherRef = useRef<HTMLInputElement>(null);
  const advanceTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const promptId = useId();
  const otherId = useId();
  useEffect(() => () => clearTimeout(advanceTimer.current), []);

  if (questions.length === 0) return null;

  const answers = answersProp ?? ownAnswers;
  const step = Math.min(Math.max(stepProp ?? ownStep, 0), questions.length - 1);
  const question = questions[step]!;
  const mode = question.select ?? select;
  const answer = answers[question.id] ?? NO_ANSWER;
  const isLast = step === questions.length - 1;
  const otherCopy = question.other === true ? {} : question.other || null;
  const other = otherCopy && {
    label: otherCopy.label ?? labels?.other ?? "Other",
    placeholder: otherCopy.placeholder ?? labels?.otherPlaceholder ?? "Type your answer",
  };
  const otherSelected = answer.other !== undefined;

  const goTo = (next: number) => {
    clearTimeout(advanceTimer.current);
    if (stepProp === undefined) setOwnStep(next);
    onStepChange?.(next);
  };

  const setAnswer = (value: QuestionnaireAnswer) => {
    clearTimeout(advanceTimer.current);
    const next = { ...answers, [question.id]: value };
    if (answersProp === undefined) setOwnAnswers(next);
    onAnswersChange?.(next);
    return next;
  };

  const advance = (current: QuestionnaireAnswers) => {
    if (isLast) onComplete?.(current);
    else goTo(step + 1);
  };

  const pick = (value: string) => {
    const next = setAnswer({ values: [value] });
    advanceTimer.current = setTimeout(() => {
      // The picked row unmounts with its question; keep focus in the card so
      // the digit keys keep working on the next one.
      if (!isLast && rootRef.current?.contains(document.activeElement)) {
        rootRef.current.focus({ preventScroll: true });
      }
      advance(next);
    }, advanceDelay);
  };

  const toggle = (value: string) => {
    const chosen = answer.values.includes(value)
      ? answer.values.filter((v) => v !== value)
      : [...answer.values, value];
    setAnswer({
      ...answer,
      values: question.options.map((o) => o.value).filter((v) => chosen.includes(v)),
    });
  };

  const setOther = (text: string) =>
    setAnswer(mode === "single" ? { values: [], other: text } : { ...answer, other: text });

  const selectOther = (selected: boolean) => {
    if (!selected) {
      setAnswer({ values: answer.values });
      return;
    }
    setOther(answer.other ?? "");
    otherRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (mode !== "single" || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (!/^[1-9]$/.test(event.key)) return;
    const index = Number(event.key) - 1;
    const option = question.options[index];
    if (option) {
      event.preventDefault();
      pick(option.value);
    } else if (other && index === question.options.length) {
      event.preventDefault();
      selectOther(true);
    }
  };

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={cx(
        "flex flex-col gap-3 rounded-2xl bg-background-primary-default p-4 outline-none",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <PillTabList aria-label="Questions" className="min-w-0 flex-wrap">
          {questions.map((item, index) => (
            <PillTab
              key={item.id}
              variant="gray"
              isSelected={index === step}
              onSelect={() => goTo(index)}
            >
              {item.stepLabel ?? `Step ${index + 1}`}
            </PillTab>
          ))}
        </PillTabList>
        {onDismiss && (
          <CloseButton size="sm" aria-label="Dismiss" onClick={onDismiss} className="ml-auto mt-1" />
        )}
      </div>

      <AnimatePresence initial={false} mode="wait">
        <motion.div
          key={question.id}
          initial={{ opacity: 0, x: 12 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.2, ease: EASE_OUT }}
          className="flex flex-col gap-3"
        >
          <p id={promptId} className="text-body-medium text-text-primary">
            {question.question}
          </p>
          <div role="group" aria-labelledby={promptId} className="flex flex-col gap-1.5">
            {question.options.map((option, index) => {
              const selected = answer.values.includes(option.value);
              return mode === "single" ? (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => pick(option.value)}
                  className={rowClass(selected)}
                >
                  <Marker selected={selected}>{index < 9 ? index + 1 : null}</Marker>
                  <OptionText label={option.label} description={option.description} />
                </button>
              ) : (
                <AriaCheckbox
                  key={option.value}
                  isSelected={selected}
                  onChange={() => toggle(option.value)}
                  className={rowClass(selected)}
                >
                  {(state) => (
                    <>
                      <span className="mt-0.5 flex">
                        <CheckboxGlyph state={state} />
                      </span>
                      <OptionText label={option.label} description={option.description} />
                    </>
                  )}
                </AriaCheckbox>
              );
            })}

            {other && (
              <div className={rowClass(otherSelected)}>
                {mode === "single" ? (
                  <button
                    type="button"
                    aria-pressed={otherSelected}
                    aria-label={other.label}
                    onClick={() => selectOther(!otherSelected)}
                    className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                  >
                    <Marker selected={otherSelected}>
                      {question.options.length < 9 ? question.options.length + 1 : null}
                    </Marker>
                  </button>
                ) : (
                  <AriaCheckbox
                    isSelected={otherSelected}
                    onChange={selectOther}
                    aria-label={other.label}
                    className="mt-0.5 flex cursor-pointer"
                  >
                    {(state) => <CheckboxGlyph state={state} />}
                  </AriaCheckbox>
                )}
                {/* A click on the row's text lands in the field and picks the row. */}
                {/* biome-ignore lint/a11y/useKeyWithClickEvents: the label only forwards a pointer click; keyboard users reach the field directly. */}
                <label
                  htmlFor={otherId}
                  onClick={() => {
                    if (!otherSelected) selectOther(true);
                  }}
                  className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1"
                >
                  <span className="text-body-medium text-text-primary">
                    {other.label}
                  </span>
                  <input
                    ref={otherRef}
                    id={otherId}
                    type="text"
                    value={answer.other ?? ""}
                    placeholder={other.placeholder}
                    onChange={(event) => setOther(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                      event.preventDefault();
                      advance(answers);
                    }}
                    className="w-full min-w-0 bg-transparent text-body-2-regular text-text-primary outline-none placeholder:text-text-tertiary"
                  />
                </label>
              </div>
            )}
          </div>
        </motion.div>
      </AnimatePresence>

      <div className="flex items-center justify-end gap-2">
        {questions.length > 1 && (
          <Button
            variant="secondary"
            size="small"
            disabled={step === 0}
            onClick={() => goTo(step - 1)}
            className="mr-auto rounded-full"
          >
            {labels?.previous ?? "Previous"}
          </Button>
        )}
        <Button variant="primary" size="small" onClick={() => advance(answers)} className="rounded-full">
          {isLast ? (labels?.complete ?? "Submit") : (labels?.next ?? "Next")}
        </Button>
      </div>
    </div>
  );
}
