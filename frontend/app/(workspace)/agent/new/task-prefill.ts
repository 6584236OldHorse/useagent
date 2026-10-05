/**
 * Whether the URL the composer page was opened with already names a task: a
 * repository, a non-blank prompt, or a skill or playbook to run with (the
 * composer reads ?skill= itself). A plain module on purpose: the Server
 * Component page calls it, and an export of a "use client" module is a client
 * reference there, not a function.
 */
export function taskPrefilled(task: {
  readonly repo: string | null;
  readonly prompt: string;
  readonly skill: string | null;
}): boolean {
  return Boolean(task.repo) || task.prompt.trim() !== "" || Boolean(task.skill);
}
