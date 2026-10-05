"use client";

import { RiFeedbackLine, RiThumbDownLine, RiThumbUpLine } from "@remixicon/react";
import { useState } from "react";
import { Button } from "@/components/base/buttons/button";
import * as Modal from "@/components/base/modal/modal";
import * as Textarea from "@/components/base/textarea/textarea";
import { backendFetch } from "@/lib/backend-fetch";

export type FeedbackVerdict = "good" | "bad";
export const FEEDBACK_TEXT_MAX = 2000;

/** The line shown when the backend refuses the feedback. */
export function feedbackFailureMessage(status: number, body: { error?: unknown }): string {
  if (status === 429) return "Too many messages in a short time. Try again in a few minutes.";
  if (status === 404) return "This run is no longer available.";
  return typeof body.error === "string" ? body.error : "Could not send the feedback. Try again.";
}

const VERDICTS: ReadonlyArray<{ value: FeedbackVerdict; label: string; icon: typeof RiThumbUpLine }> = [
  { value: "good", label: "Good", icon: RiThumbUpLine },
  { value: "bad", label: "Bad", icon: RiThumbDownLine },
];

/** The dialog body: a good or bad choice, a note, and the send row. Stateless
 *  so static markup can hold it (the modal around it mounts through a portal). */
export function RunFeedbackForm({
  verdict,
  text,
  busy,
  error,
  sent,
  onVerdict,
  onText,
  onSubmit,
  onClose,
}: {
  verdict: FeedbackVerdict | null;
  text: string;
  busy: boolean;
  error: string | null;
  sent: boolean;
  onVerdict: (verdict: FeedbackVerdict) => void;
  onText: (text: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  if (sent) {
    return (
      <>
        <Modal.Body className="pt-2">
          <p className="text-paragraph-sm text-text-secondary">Thanks, your feedback was sent.</p>
        </Modal.Body>
        <Modal.Footer className="justify-end">
          <Button variant="secondary" size="small" className="rounded-full" onClick={onClose}>
            Close
          </Button>
        </Modal.Footer>
      </>
    );
  }
  return (
    <>
      <Modal.Body className="flex flex-col gap-4 pt-2">
        <div role="group" aria-label="How did this run go?" className="flex gap-2">
          {VERDICTS.map((option) => (
            <Button
              key={option.value}
              type="button"
              variant={verdict === option.value ? "primary" : "secondary"}
              size="small"
              leadingIcon={option.icon}
              aria-pressed={verdict === option.value}
              className="rounded-full"
              onClick={() => onVerdict(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <Textarea.Root
          simple
          rows={4}
          value={text}
          maxLength={FEEDBACK_TEXT_MAX}
          placeholder="What went well or wrong? (optional)"
          aria-label="Feedback note"
          onChange={(event) => onText(event.target.value)}
        />
        {error && (
          <p role="alert" className="text-paragraph-xs text-error-base">
            {error}
          </p>
        )}
      </Modal.Body>
      <Modal.Footer className="justify-end">
        <Button variant="secondary" size="small" className="rounded-full" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="small"
          className="rounded-full"
          disabled={!verdict || busy}
          onClick={onSubmit}
        >
          {busy ? "Sending" : "Send"}
        </Button>
      </Modal.Footer>
    </>
  );
}

/** Session header control: opens the dialog and posts the verdict for `runId`.
 *  A resend updates the same feedback (the backend keeps one row per run and
 *  person), so the last values stay in the form after sending. */
export function RunFeedback({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState<FeedbackVerdict | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const openDialog = () => {
    setSent(false);
    setError(null);
    setOpen(true);
  };

  const submit = async () => {
    if (!verdict || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await backendFetch(`/api/runs/${runId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict, text }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: unknown };
        setError(feedbackFailureMessage(response.status, body));
        return;
      }
      setSent(true);
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="small"
        leadingIcon={RiFeedbackLine}
        className="rounded-full"
        title="Give feedback on this run"
        onClick={openDialog}
      >
        Feedback
      </Button>
      <Modal.Root open={open} onOpenChange={setOpen}>
        <Modal.Content className="max-w-[440px] rounded-2xl border border-border-button-default bg-background-primary-default shadow-dropdown">
          <Modal.Header
            title="How did this run go?"
            description="Goes to the team running useAgent, with a link to this run."
          />
          <RunFeedbackForm
            verdict={verdict}
            text={text}
            busy={busy}
            error={error}
            sent={sent}
            onVerdict={setVerdict}
            onText={setText}
            onSubmit={() => void submit()}
            onClose={() => setOpen(false)}
          />
        </Modal.Content>
      </Modal.Root>
    </>
  );
}
