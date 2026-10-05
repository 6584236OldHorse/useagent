"use client";

import { RiQuestionLine } from "@remixicon/react";
import { useState } from "react";
import {
  Questionnaire,
  type QuestionnaireAnswers,
  type QuestionnaireQuestion,
} from "@/components/application/questionnaire/questionnaire";
import { composeQuestionAnswers, type PendingQuestion } from "@/components/chat/question-state";

export function QuestionCard({
  request,
  submitting,
  error,
  onSubmit,
}: {
  request: PendingQuestion;
  submitting: boolean;
  error: string | null;
  onSubmit: (answers: string[][]) => void | Promise<void>;
}) {
  // Keyed by request so a new question starts on its first step.
  const [position, setPosition] = useState({ id: request.id, step: 0 });
  const step = position.id === request.id ? position.step : 0;
  const goTo = (next: number) => setPosition({ id: request.id, step: next });

  const questions: QuestionnaireQuestion[] = request.questions.map((item, index) => ({
    id: String(index),
    question: item.question,
    stepLabel: item.header,
    select: item.multiple ? "multiple" : "single",
    options: item.options.map((option) => ({
      value: option.label,
      label: option.label,
      description: option.description || undefined,
    })),
    other: item.custom,
  }));

  const complete = (answers: QuestionnaireAnswers) => {
    if (submitting) return;
    const selected = request.questions.map((_, index) => answers[String(index)]?.values ?? []);
    const custom = request.questions.map((_, index) => answers[String(index)]?.other ?? "");
    const composed = composeQuestionAnswers(request, selected, custom);
    if (composed) {
      void onSubmit(composed);
      return;
    }
    // Done with a question still open: take the user to it.
    const open = selected.findIndex((values, index) => values.length === 0 && !custom[index]?.trim());
    if (open >= 0) goTo(open);
  };

  return (
    <div className="space-y-2" data-testid="native-question-card">
      <div className="flex items-center gap-2 px-1">
        <RiQuestionLine className="text-accent-500 size-4" aria-hidden />
        <p className="text-body-2-medium text-text-primary">Agent needs your input</p>
        <p className="text-caption-1-regular text-text-tertiary">
          Your answer continues this turn immediately.
        </p>
      </div>
      <Questionnaire
        key={request.id}
        questions={questions}
        step={step}
        onStepChange={goTo}
        onComplete={complete}
        labels={{
          complete: submitting ? "Sending…" : "Continue",
          otherPlaceholder: "Type a custom answer",
        }}
        className="border-border-button-default border"
      />
      {error && <p className="text-caption-1-regular px-1 text-red-500">{error}</p>}
    </div>
  );
}
