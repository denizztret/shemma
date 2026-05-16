// DRW-024: supported kinds — single source of truth backend `domain/supported-kinds.ts`.
// "draw"/"freeform" больше не маппится — broken backend state с unknown kind
// получит null из nodeToShape (см. from-canvas-state.ts) и будет skipped.
export function kindToTldraw(
  kind: string,
): "rectangle" | "ellipse" | "diamond" | "note" | "text" | null {
  if (kind === "rect") return "rectangle";
  if (kind === "ellipse") return "ellipse";
  if (kind === "diamond") return "diamond";
  if (kind === "sticky") return "note";
  if (kind === "text") return "text";
  return null;
}
