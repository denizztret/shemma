// apps/frontend/src/settings/useSettingsTrigger.ts
import { useEffect, useRef, useState } from "react";
import type { Editor } from "tldraw";

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

export type TriggerState = {
  target: Target | null;
};

export function useSettingsTrigger(editor: Editor | null): TriggerState & { close: () => void } {
  const [target, setTarget] = useState<Target | null>(null);
  const editorRef = useRef(editor);
  editorRef.current = editor;

  useEffect(() => {
    if (!editor) return;
    const container = editor.getContainer();

    function onPointerDown(e: PointerEvent) {
      if (!e.altKey) return;
      e.preventDefault();
      e.stopPropagation();

      const ed = editorRef.current;
      if (!ed) return;

      const screen = { x: e.clientX, y: e.clientY };
      const page = ed.screenToPage(screen);
      const hit = ed.getShapeAtPoint(page);
      const selected = ed.getSelectedShapeIds() as unknown as string[];

      const result = resolveTarget({
        hit: hit ? { id: hit.id, type: hit.type, meta: hit.meta as Record<string, unknown> } : null,
        selectedIds: selected,
        pointerScreen: screen,
        bbox: (ids) => {
          if (ids.length === 0) return null;
          if (ids.length === 1) {
            const b = ed.getShapePageBounds(ids[0] as never);
            if (!b) return null;
            const tl = ed.pageToScreen({ x: b.x, y: b.y });
            const br = ed.pageToScreen({ x: b.x + b.w, y: b.y + b.h });
            return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
          }
          const b = ed.getSelectionPageBounds();
          if (!b) return null;
          const tl = ed.pageToScreen({ x: b.x, y: b.y });
          const br = ed.pageToScreen({ x: b.x + b.w, y: b.y + b.h });
          return { x: tl.x, y: tl.y, w: br.x - tl.x, h: br.y - tl.y };
        },
      });
      setTarget(result);
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setTarget(null);
    }

    container.addEventListener("pointerdown", onPointerDown, { capture: true });
    window.addEventListener("keydown", onKey);

    const dispose = editor.store.listen(() => setTarget(null), { scope: "session" });

    return () => {
      container.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("keydown", onKey);
      dispose();
    };
  }, [editor]);

  return { target, close: () => setTarget(null) };
}
