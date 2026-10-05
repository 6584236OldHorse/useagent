import { type ApiStep, type FileEntry, parseFileEntries, parseStepCode } from "./types";

/** A tool step whose provider reported failure (`code.error === true`). A failed
 * write, edit or patch touched nothing, so every file surface (Editor, Diff,
 * the chooser gate) leaves it out through this one test. */
export function stepFailed(step: ApiStep): boolean {
  const code = parseStepCode(step);
  return !!code && typeof code === "object" && (code as Record<string, unknown>).error === true;
}

/** Collapse a run's file steps into a de-duplicated list of touched files,
 * latest change kind winning, ordered by first appearance. */
export function filesFromSteps(steps: readonly ApiStep[]): FileEntry[] {
  const byPath = new Map<string, FileEntry>();
  for (const step of steps) {
    if (step.kind !== "file" || stepFailed(step)) continue;
    for (const entry of parseFileEntries(step)) {
      const existing = byPath.get(entry.path);
      // Keep original insertion order; refresh the change kind + latest content.
      byPath.set(
        entry.path,
        existing
          ? { ...existing, kind: entry.kind, content: entry.content ?? existing.content }
          : entry,
      );
    }
  }
  return [...byPath.values()];
}
