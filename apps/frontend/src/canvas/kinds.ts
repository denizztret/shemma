export function kindToTldraw(
  kind: string,
): "rectangle" | "ellipse" | "diamond" | "note" | "text" | "draw" {
  if (kind === "rect") return "rectangle";
  if (kind === "ellipse") return "ellipse";
  if (kind === "diamond") return "diamond";
  if (kind === "sticky") return "note";
  if (kind === "text") return "text";
  if (kind === "freeform") return "draw";
  return "rectangle";
}
