# ADR-0002: Координаты children в группе — absolute

**Date:** 2026-05-16
**Status:** Decided

## Context

Phase 2.1 spec §3.6.4 не специфицирует, в какой системе координат хранятся `x/y` узлов, принадлежащих к группе (через `Group.children: ElementId[]`):

- **Absolute** — `node.x/y` всегда в координатах canvas; `Group` это только marker без координатной трансформации.
- **Relative** — `node.x/y` интерпретируется как смещение от `Group.x/y`; frontend применяет parent offset при рендере.

DRW-005 (D5 из smoke session 2) обнаружил расхождение: backend хранил children в `(10, 10)` absolute, frontend визуально показывал их в `(10, 10)` canvas — НЕ внутри группы, которая лежала в `(180, 160)`. Bug-репорт назвал это "расхождением backend/frontend", хотя real cause был в DRW-003 (pin discipline + ELK layered placement).

## Decision

**Absolute coordinates for all nodes, всегда.** `Group` остаётся canonical container-marker (`children: ElementId[]`), без координатной трансформации. Children группы должны иметь абсолютные `x/y`, гарантирующие что они геометрически лежат внутри `Group.{x, y, w, h}`.

## Why

1. **Container model invariant (CLAUDE.md):** `meta.parent` не пишется на узлах; `Group.children: ElementId[]` каноничен. Если бы коорды были relative, на reader-side требовался бы parent lookup для каждого render — это нарушает self-contained принцип canonical model.
2. **Frontend simplicity:** `from-canvas-state.ts` уже читает `n.x/y` напрямую в tldraw `Shape.{x, y}`. tldraw не имеет встроенного "child-of-group" coord transform для произвольных group-типов — это потребовало бы writing a custom resolver.
3. **ELK output совместим:** ELK layered с `INCLUDE_CHILDREN` возвращает hierarchical positions (children внутри parent относительные); наш `collectChildren` уже корректно конвертирует через `offsetX/offsetY` (`apps/backend/src/domain/layout.ts:129-146`).
4. **Backend persistence prosto:** Envelope JSON — flat array of nodes + flat array of groups + children references. Не требует hierarchical encoding.

## Consequences

- `apps/backend/src/domain/layout.ts:collectChildren` остаётся как есть (absolute via offset traversal).
- `apps/backend/src/routes/domain.ts` writeback использует `lr.positions[nodeId].x/y` (absolute) для children — без вычитания group offset.
- `apps/frontend/src/canvas/from-canvas-state.ts` читает `n.x/y` напрямую без parent lookup.
- Если в будущем понадобится `Group.collapsed` (fold/unfold) — это **визуальная** проекция (frontend hides children), а не координатная трансформация (children координаты не меняются).
- Pin discipline: `meta.pinned + meta.position` на children держится в абсолютных coords (как у любого other node).

## Regression coverage

`apps/backend/tests/layout-pin-discipline.test.ts`:
- "group + 2 children + layout → children лежат внутри group bbox" — проверяет что после layout каждый child геометрически внутри `(group.x, group.y, group.w, group.h)`.
- "group + children + другая независимая node (репро D5)" — проверяет что узлы вне группы не оказываются в её bbox случайно.
