/**
 * The member's sandbox minutes against the deployment's per-member cap, from
 * the real backend GET /api/sandbox-minutes. Pure: no React, so the usage card
 * and Settings > Usage share one reading of the figures.
 */

export interface SandboxMinutes {
  readonly used: number;
  /** Null when the deployment runs without a cap. */
  readonly cap: number | null;
}

/** Normalize GET /api/sandbox-minutes; null on an unusable shape. */
export function parseSandboxMinutes(data: unknown): SandboxMinutes | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.used !== "number" || !Number.isFinite(d.used)) return null;
  return { used: d.used, cap: typeof d.cap === "number" && Number.isFinite(d.cap) ? d.cap : null };
}

/** "Used 12 of 600 minutes"; without a cap, just what was used. */
export function sandboxMinutesLabel(minutes: SandboxMinutes): string {
  if (minutes.cap !== null) return `Used ${minutes.used} of ${minutes.cap} minutes`;
  return `Used ${minutes.used} ${minutes.used === 1 ? "minute" : "minutes"}`;
}

export function sandboxMinutesCapped(minutes: SandboxMinutes): boolean {
  return minutes.cap !== null && minutes.used >= minutes.cap;
}
