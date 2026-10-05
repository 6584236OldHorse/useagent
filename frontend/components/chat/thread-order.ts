import type { ApiRun } from "@useagent/agent-client/wire";

/**
 * Canonical thread order, the backend's: a run's place in its thread
 * (`thread_seq`, assigned at acceptance under the thread's lock) first, then
 * `created_at`, then id. `created_at` alone is not enough on the wire: it is
 * truncated to milliseconds there, so two replies accepted in the same
 * millisecond tie and the id would decide, which is not acceptance order. Rows
 * from before the sequence report 0 (or nothing) and still sort by time among
 * themselves, before every sequenced run.
 */
export function compareThreadOrder(a: Pick<ApiRun, "id" | "created_at" | "thread_seq">, b: Pick<ApiRun, "id" | "created_at" | "thread_seq">): number {
  const seq = (a.thread_seq ?? 0) - (b.thread_seq ?? 0);
  if (seq !== 0) return seq;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
