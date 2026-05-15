const seen = new Set<string>();
export function rememberOurOpId(id: string) {
  seen.add(id);
  setTimeout(() => seen.delete(id), 10_000);
}
export function isOurOp(id?: string) {
  return !!id && seen.has(id);
}
