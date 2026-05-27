// apps/frontend/src/settings/useSettingsTrigger.ts
export type Anchor = { x: number; y: number; w?: number; h?: number };

export type Target =
  | { kind: "board"; anchor: Anchor }
  | { kind: "selection"; anchor: Anchor }
  | { kind: "node"; subjectId: string; anchor: Anchor };

export type ResolveInput = {
  hit: { id: string; type: string; meta?: Record<string, unknown> } | null;
  selectedIds: string[];
  pointerScreen: { x: number; y: number };
  bbox: (ids: string[]) => Anchor | null;
};

export function resolveTarget(input: ResolveInput): Target | null {
  const { hit, selectedIds, pointerScreen, bbox } = input;

  if (hit && selectedIds.includes(hit.id) && selectedIds.length > 1) {
    const a = bbox(selectedIds);
    if (!a) return null;
    return { kind: "selection", anchor: a };
  }
  if (hit) {
    if (hit.type === "schema-container") {
      const a = bbox([hit.id]);
      if (!a) return null;
      return { kind: "selection", anchor: a };
    }
    if (hit.meta?.didrawId) {
      const a = bbox([hit.id]);
      if (!a) return null;
      return { kind: "node", subjectId: hit.id, anchor: a };
    }
    return null;
  }
  if (selectedIds.length >= 1) {
    const a = bbox(selectedIds);
    if (!a) return null;
    return { kind: "selection", anchor: a };
  }
  return { kind: "board", anchor: pointerScreen };
}
