/**
 * Humanize a timestamp into "Xs ago" / "Xm ago" / "Xh ago" / "Xd ago" strings.
 * No external dependencies — pure function ≤30 LOC.
 */
export function humanize(isoOrMs: string | number, now = Date.now()): string {
  const ts =
    typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs as string);
  if (Number.isNaN(ts)) return "unknown";
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(diff / 3_600_000);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(diff / 86_400_000);
  return `${d}d ago`;
}
