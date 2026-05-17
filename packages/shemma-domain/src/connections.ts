export type ConnectionKind = "sync" | "async" | "data" | "dep";
export const ALL_KINDS: readonly ConnectionKind[] = ["sync", "async", "data", "dep"];
export function isValidConnectionKind(s: string): s is ConnectionKind {
  return (ALL_KINDS as readonly string[]).includes(s);
}
