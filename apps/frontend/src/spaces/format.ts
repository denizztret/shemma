/**
 * Tiny formatting helpers for the spaces landing page.
 * Pure functions, no dependencies — testable in isolation.
 */

/**
 * Truncate a long absolute path for compact display while keeping the most
 * recognisable last three segments intact. Returns the path as-is when it is
 * already ≤ 50 characters.
 *
 * Example:
 *   `/Users/me/Projects/sandbox/di.draw` → `/Users/me/Projects/sandbox/di.draw` (≤ 50)
 *   `/very/long/.../sandbox/some/project/here` → `/very/.../some/project/here`
 */
export function truncatePath(p: string, max = 50): string {
  if (p.length <= max) return p;
  const segments = p.split("/");
  if (segments.length <= 4) return p;
  const head = segments[0] === "" ? "" : segments[0];
  const tail = segments.slice(-3).join("/");
  return `${head}/.../${tail}`;
}

/**
 * Human-readable relative time: "just now", "5 minutes ago", "2 hours ago",
 * "3 days ago". No external deps; falls back to ISO string when parsing fails.
 */
export function relativeTime(iso: string, now = Date.now()): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return iso;
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 30) return "just now";
  if (sec < 60) return `${sec} seconds ago`;
  const min = Math.floor(diff / 60_000);
  if (min < 60) return min === 1 ? "1 minute ago" : `${min} minutes ago`;
  const hr = Math.floor(diff / 3_600_000);
  if (hr < 24) return hr === 1 ? "1 hour ago" : `${hr} hours ago`;
  const day = Math.floor(diff / 86_400_000);
  return day === 1 ? "1 day ago" : `${day} days ago`;
}
