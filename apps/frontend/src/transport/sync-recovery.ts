/**
 * DRW-137 — pure recovery helpers for the WS store-sync loop.
 *
 * Keeps timing / scheduling logic out of App.tsx so it can be unit-tested
 * without a real Editor or WebSocket. Used by the truncated-recovery loop
 * in apps/frontend/src/App.tsx.
 */

/** Maximum backoff between truncated retries (ms). */
export const TRUNCATED_BACKOFF_MAX_MS = 30_000;

/**
 * Exponential backoff for truncated-recovery retries.
 *
 * retryNumber = number of failures so far (0 means "first attempt — no wait").
 *   0 → 0
 *   1 → 1000
 *   2 → 2000
 *   3 → 4000
 *   4 → 8000
 *   5 → 16000
 *   6+ → 30000 (capped)
 */
export function computeTruncatedBackoff(retryNumber: number): number {
  if (retryNumber <= 0) return 0;
  const base = 1000 * 2 ** (retryNumber - 1);
  return Math.min(base, TRUNCATED_BACKOFF_MAX_MS);
}
