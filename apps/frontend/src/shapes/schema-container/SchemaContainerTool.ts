// apps/frontend/src/shapes/schema-container/SchemaContainerTool.ts
//
// DRW-186 Task 5 — drag-from-corner tool для SchemaContainer.
//
// Тривиальный наследник `BaseBoxShapeTool`: tldraw сам отвечает за state-machine
// Idle/Pointing, drag math, переход в `select.resizing` с
// `handle: 'bottom_right'`, вызов `getDefaultProps()` ShapeUtil'а и применение
// style-defaults (color/fill/dash) через `editor.getStyleForNextShape`. См.
// probe-документ `docs/probes/2026-05-27-drw-186-probe-tool-api.md` §1.3 / §1.6.

import { BaseBoxShapeTool } from "tldraw";

export class SchemaContainerTool extends BaseBoxShapeTool {
  static override id = "schema-container";
  static override initial = "idle";
  override shapeType = "schema-container" as const;
}
