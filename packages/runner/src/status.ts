// One JSON line per state change on stdout; the desktop shell reads these.

export type RunnerState = "starting" | "pulling" | "online" | "offline" | "error";

export interface StatusLine {
  readonly state: RunnerState;
  readonly detail: string;
  readonly progress?: number;
}

export function formatStatus(line: StatusLine): string {
  return JSON.stringify({
    state: line.state,
    detail: line.detail,
    ...(line.progress !== undefined ? { progress: Math.max(0, Math.min(1, line.progress)) } : {}),
  });
}

export function emitStatus(line: StatusLine, out: { write(text: string): unknown } = process.stdout): void {
  out.write(`${formatStatus(line)}\n`);
}
