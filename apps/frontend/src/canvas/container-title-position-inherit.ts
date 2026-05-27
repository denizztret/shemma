// apps/frontend/src/canvas/container-title-position-inherit.ts
//
// DRW-186 frame-scope (extension):
// При создании SchemaContainer'а INSIDE Frame'а, у которого есть
// `meta.didrawContainerTitlePosition`, применяем это значение к новому shape'у
// до его коммита в store.
//
// Почему registerBeforeCreateHandler:
//   - tldraw side-effects вызываются для local creates (user gesture), но НЕ
//     для `mergeRemoteChanges` (per tldraw store docs) — это правильно,
//     потому что WS-applied shapes уже приходят с готовыми props.
//   - В этом hook'е shape.parentId уже выставлен tldraw-логикой (frame
//     containment учитывается до того, как shape кладётся в store).
//
// Почему НЕ через `getDefaultProps()`:
//   - `getDefaultProps()` не имеет shape context'а (parentId неизвестен).
//   - Board-level fallback всё равно идёт через `resolveBoardTitlePosition()`
//     внутри `getDefaultProps()` — это нижний уровень иерархии.
//
// Цепочка дефолтов (creation-time, не render-time SSOT):
//   1. parent Frame `meta.didrawContainerTitlePosition` → этот handler.
//   2. board-level `room.meta.containerTitlePosition` → getDefaultProps.
//   3. fallback `"inside-center"` → normalizeTitlePosition.

import type { Editor, TLShape } from "tldraw";
import { normalizeTitlePosition } from "../shapes/schema-container/title-position";

/**
 * Pure helper — выделена для тестируемости (handler внутри не пускается без
 * full tldraw editor instance, а здесь — простой function from inputs to shape).
 *
 * Inputs:
 *   - `shape` — кандидат на коммит (sideEffects.beforeCreate);
 *   - `getParent` — lookup parent shape по id (фасад над editor.getShape).
 *
 * Returns:
 *   - new shape с заинъектированным `props.titlePosition` если parent — Frame
 *     с подходящей meta; иначе shape без изменений.
 */
export function applyFrameTitlePositionInheritance(
  shape: TLShape,
  getParent: (id: string) => { type?: string; meta?: Record<string, unknown> } | undefined,
): TLShape {
  if (shape.type !== "schema-container") return shape;
  const parentId = (shape as { parentId?: string }).parentId;
  if (!parentId) return shape;
  const parent = getParent(parentId);
  if (!parent || parent.type !== "frame") return shape;
  const meta = parent.meta;
  const fromFrame = meta?.didrawContainerTitlePosition;
  if (typeof fromFrame !== "string") return shape;
  const next = normalizeTitlePosition(fromFrame);
  const currentProps = shape.props as { titlePosition?: string };
  if (currentProps.titlePosition === next) return shape;
  return {
    ...shape,
    props: { ...currentProps, titlePosition: next },
  } as TLShape;
}

export function registerContainerTitlePositionInherit(editor: Editor): () => void {
  return editor.sideEffects.registerBeforeCreateHandler(
    "shape",
    (shape: TLShape): TLShape =>
      applyFrameTitlePositionInheritance(shape, (id) =>
        editor.getShape(id as never) as
          | { type?: string; meta?: Record<string, unknown> }
          | undefined,
      ),
  );
}
