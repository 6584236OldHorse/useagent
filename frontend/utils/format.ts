/**
 * Presentational formatters shared across surfaces (dashboard, workspace fleet,
 * runs list, knowledge). Pure and isomorphic — safe on server and client.
 */

/** Coarse run duration: "-" / "8s" / "2m 05s" (rounded to whole seconds). */
export function formatDuration(ms: number | null): string {
  if (!ms || ms <= 0) return "-";
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m === 0 ? `${s}s` : `${m}m ${String(s).padStart(2, "0")}s`;
}

const compact = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Compact number: 12480 → "12.5K", 1_200_000 → "1.2M". */
export function compactNumber(n: number): string {
  return compact.format(n);
}

/** Rough per-run token cost for the clearly-estimated "tokens" headline. */
export const TOKENS_PER_RUN = 48_500;

/** "≈ tokens" headline derived purely from run count — labelled estimated in UI. */
export function estimatedTokens(runCount: number): string {
  return compact.format(runCount * TOKENS_PER_RUN);
}

/** Relative timestamp: "just now" / "5m ago" / "3h ago" / "2d ago" / "4w ago". */
export function relativeTime(
  value?: string | number | null,
  now: number = Date.now(),
): string {
  const ms =
    value == null ? 0 : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(ms) || ms <= 0) return "just now";
  const diff = now - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return `${Math.floor(day / 7)}w ago`;
}

/** Compact relative time for dense rails ("8h", "3d", "now") - same buckets as
 * `relativeTime`, without the " ago" suffix that eats sidebar row width. */
export function relativeTimeShort(
  value?: string | number | null,
  now: number = Date.now(),
): string {
  const long = relativeTime(value, now);
  return long === "just now" ? "now" : long.replace(" ago", "");
}

/** Precise elapsed time for a work log: "4.3s", "1m 8.5s", "1h 2m". Null when
 *  there is nothing to report (missing, zero or negative). */
export function formatElapsed(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  const rest = (seconds - minutes * 60).toFixed(1);
  return rest === "0.0" ? `${minutes}m` : `${minutes}m ${rest}s`;
}
