/**
 * Whether the URL the composer page was opened with already names a task: a
 * repository or a non-blank prompt, the parameters the page reads. A plain
 * module on purpose: the Server Component page calls it, and an export of a
 * "use client" module is a client reference there, not a function.
 */
export function taskPrefilled(task: { readonly repo: string | null; readonly prompt: string }): boolean {
  return Boolean(task.repo) || task.prompt.trim() !== "";
}
