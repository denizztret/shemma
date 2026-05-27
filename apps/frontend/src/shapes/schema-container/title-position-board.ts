// apps/frontend/src/shapes/schema-container/title-position-board.ts
//
// DRW-186 — резолверы дефолтного `titlePosition` для SchemaContainer.
//
// Двухуровневая иерархия дефолтов (creation-time, не render-time SSOT):
//
//   1. Frame-level — `frame.meta.didrawContainerTitlePosition`.
//      Это "bulk-apply scope": когда пользователь меняет setting на Frame'е,
//      сам Frame НЕ перерисовывается, но все SchemaContainer-дети сразу
//      получают `props.titlePosition = next` (см. SettingsPopover Frame-handler)
//      и newly-created SchemaContainer внутри этого Frame'а наследует значение.
//
//   2. Board-level — `editor.getDocumentSettings().meta.containerTitlePosition`.
//      Дефолт для новых SchemaContainer'ов вне Frame'а (или если у Frame'а
//      нет своего meta-override).
//
//   3. Fallback — `"inside-center"` (через `normalizeTitlePosition`).
//
// Вызывается из `SchemaContainerShapeUtil.getDefaultProps()` (board fallback)
// и из side-effect handler'а при создании shape'а (frame inheritance — после
// того, как parent уже известен). `resolveBoardTitlePosition` оставлен thin
// wrapper'ом для backward compat / call-sites без parent context'а.

import type { Editor, TLShapeId } from "tldraw";
import {
  normalizeTitlePosition,
  type SchemaContainerTitlePosition,
} from "./title-position";

export function resolveBoardTitlePosition(
  editor: Editor,
): SchemaContainerTitlePosition {
  const meta = editor.getDocumentSettings().meta as
    | Record<string, unknown>
    | undefined;
  return normalizeTitlePosition(meta?.containerTitlePosition);
}

/**
 * Резолвер дефолта для НОВОГО SchemaContainer'а с учётом parent-Frame'а.
 *
 * Resolution chain (nearest-first):
 *  1. `parent.meta.didrawContainerTitlePosition` (если parent — Frame и имеет
 *     это поле).
 *  2. `room.meta.containerTitlePosition` (board-default).
 *  3. `"inside-center"` (fallback из `normalizeTitlePosition`).
 *
 * `parentId` опционален — отсутствие = walk straight to board-default.
 */
export function resolveTitlePositionForNew(
  editor: Editor,
  parentId?: TLShapeId,
): SchemaContainerTitlePosition {
  if (parentId) {
    const parent = editor.getShape(parentId);
    if (parent?.type === "frame") {
      const meta = parent.meta as Record<string, unknown> | undefined;
      const fromFrame = meta?.didrawContainerTitlePosition;
      if (typeof fromFrame === "string") {
        return normalizeTitlePosition(fromFrame);
      }
    }
  }
  return resolveBoardTitlePosition(editor);
}
