import {
  type Editor,
  type TLShape,
  type TLShapeId,
  renderPlaintextFromRichText,
} from "tldraw";

// Phase 3.0: mermaid import пишет shapes напрямую в tldraw store через
// createMermaidDiagram(editor, source). Эти мутации идут как source:'user' →
// startStoreSync (transport/ws.ts) автоматически шлёт их батчем в backend.
// Нет промежуточного "build ops → sendPatch" — store сам и есть транспортный
// слой.

// Lazy-load @tldraw/mermaid — pulls in mermaid + heavy deps; only paid когда
// пользователь реально импортирует.
async function loadMermaid() {
  return await import("@tldraw/mermaid");
}

function plaintextLabel(editor: Editor, s: TLShape): string | undefined {
  // biome-ignore lint/suspicious/noExplicitAny: tldraw shape props not in public types
  const rt = (s as any).props?.richText;
  if (!rt) return undefined;
  const text = renderPlaintextFromRichText(editor, rt);
  return text || undefined;
}

/** Slugify shape label / type into a stable didrawName candidate. Same idea как
 * у backend identifiers: lowercase, dash-separated, ascii-safe.
 * Без коллизий: caller (importMermaid) дописывает индекс при дубликате. */
function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "shape"
  );
}

export type MermaidImportResult = {
  ok: true;
  shapeIds: TLShapeId[];
  /** Subset of shapeIds где сохранён meta.mermaidSource (root frame'ы импорта). */
  sourceTargetIds: TLShapeId[];
};

/**
 * Импортировать Mermaid diagram в editor store. createMermaidDiagram мутирует
 * store напрямую (добавляет shapes / arrow bindings); мы лишь:
 *   1) запоминаем set'ы до/после, чтобы знать какие записи добавлены;
 *   2) проставляем meta.didrawName на новых shapes (через updateShapes) —
 *      backend rebuild'ит didrawIndex из этих имён;
 *   3) сохраняем meta.mermaidSource на root frame'ах (или, если frame'а нет,
 *      на всех новых root shapes) — foundation для future edit UI (DRW-053);
 *   4) даём caller'у список новых shape id (для zoom-to / debug).
 *
 * Сами WS-фреймы шлёт startStoreSync — ничего вручную здесь не нужно.
 *
 * Throws MermaidDiagramError на невалидный source.
 */
export async function importMermaid(
  editor: Editor,
  source: string,
): Promise<MermaidImportResult> {
  const mod = await loadMermaid();
  // biome-ignore lint/suspicious/noExplicitAny: createMermaidDiagram не в public d.ts'ках
  const mermaidMod = mod as any;

  const beforeIds = new Set<string>(
    editor.getCurrentPageShapes().map((s) => s.id as unknown as string),
  );

  await mermaidMod.createMermaidDiagram(editor, source);

  const after = editor.getCurrentPageShapes();
  const newShapes = after.filter(
    (s) => !beforeIds.has(s.id as unknown as string),
  );

  if (newShapes.length === 0) {
    throw new Error("mermaid produced no shapes");
  }

  // Определяем root shape'ы среди новых: те, чей parentId — page (а не другой
  // shape). Это либо single frame/group-обёртка (типичный случай), либо набор
  // top-level фигур (на flat-диаграммах без group). meta.mermaidSource ставим
  // на root'ы — для edit UI важно знать "от какого узла этот импорт".
  const pageId = editor.getCurrentPageId() as unknown as string;
  // biome-ignore lint/suspicious/noExplicitAny: tldraw shape parentId not typed publicly
  const isRoot = (s: TLShape) => (s as any).parentId === pageId;
  // Если есть frame'ы среди roots — предпочитаем их (контейнер импорта).
  // Иначе — все root shape'ы.
  const rootFrames = newShapes.filter((s) => isRoot(s) && s.type === "frame");
  const sourceTargets = rootFrames.length > 0 ? rootFrames : newShapes.filter(isRoot);
  const sourceTargetIds = new Set<string>(
    sourceTargets.map((s) => s.id as unknown as string),
  );
  // Безопасно: даже если нет ни одного root (createMermaidDiagram странно
  // переподцепил всё к чему-то pre-existing), не запишем mermaidSource нигде —
  // и это лучше, чем дублировать его на все 50 child-нод.

  // Назначим meta.didrawName для добавленных shapes. Берём label / shape.type,
  // дедуплицируем суффиксами -2, -3, … per-import. Параллельно — meta.mermaidSource
  // на root frame'ах.
  const usedNames = new Set<string>();
  // biome-ignore lint/suspicious/noExplicitAny: tldraw partial update types verbose; safe by id+type
  const updates: any[] = [];
  for (const s of newShapes) {
    const base =
      s.type === "arrow"
        ? `edge-${slugify(plaintextLabel(editor, s) ?? "arrow")}`
        : slugify(plaintextLabel(editor, s) ?? s.type);
    let candidate = base;
    let n = 2;
    while (usedNames.has(candidate)) {
      candidate = `${base}-${n++}`;
    }
    usedNames.add(candidate);
    const meta: Record<string, unknown> = {
      ...s.meta,
      didrawName: candidate,
    };
    if (sourceTargetIds.has(s.id as unknown as string)) {
      meta.mermaidSource = source;
    }
    updates.push({
      id: s.id,
      type: s.type,
      meta,
    });
  }
  if (updates.length > 0) {
    editor.updateShapes(updates);
  }

  return {
    ok: true,
    shapeIds: newShapes.map((s) => s.id),
    sourceTargetIds: Array.from(sourceTargetIds) as unknown as TLShapeId[],
  };
}

