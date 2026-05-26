# DRW-178 follow-up — Design

**Status:** draft v0.1
**Author:** Claude (with user)
**Branch:** `feature/drw-173-attempt-2` (от tag `0.27.1`, commit `2d6f792`)
**Research backing:** [`docs/references/drw-178-followup/research.md`](../../references/drw-178-followup/research.md)
**Date:** 2026-05-26
**Supersedes:** DRW-173 attempt-1, DRW-178 attempt-codex (b93f990, libavoid orthogonal routing) — оба отбрасываются. Подход «custom routed-arrow shape + runtime libavoid» признан тупиком (теряем нативную реактивность binding, тащим WASM в runtime, не получаем визуальной выгоды).

---

## 1. Vision

**Схема — это «живая печатная плата».**

- Стрелки **угловые** (kind:elbow), идут только по горизонтали и вертикали.
- Стрелки **не пересекаются** друг с другом там, где этого можно избежать.
- Стрелка **не проходит сквозь чужой контейнер** — только в свой target.
- Стиль и цвет shapes/containers, заданные в mermaid, **сохраняются**.

**Расположение строится умно, а не буквально по mermaid.**

Mermaid — это «что с чем соединено и кто в каком контейнере». Это вход, не диктат. Система сама решает direction subgraph (TB / LR), порядок детей, размещение anchors, elbowMidPoint — так, чтобы итог был с минимумом пересечений. Указанный direction уважается, неуказанный выбирается автоматически.

**Стрелки — настоящие коннекторы.**

Тащишь shape — стрелки тянутся за ним в реальном времени (native tldraw binding). Прикреплены к нужной стороне или к точной точке на стороне.

**Три стадии:**

1. **Генерация** — mermaid import / agent API. Узлы и стрелки появляются с дефолтными параметрами.
2. **Layout (явный вызов)** — детерминированный проход. Стадия описана в §3.2.
3. **Редактирование** — без auto-layout. Native binding follows. Light-режим smart-insert для добавления одной фигуры.

**Закладываемся, но не делаем в этой итерации:** UI-панель параметров. Архитектурно — всё через `LayoutParams`, никаких хардкодов.

---

## 2. Scope and non-goals

### In scope

- Переключить mermaid-import на `kind:"elbow"` (native tldraw arrow).
- Layout-pipeline: ELK positions → DRW-172 anchors → elbow midpoint distribution → label spacing reservation → per-container direction heuristic.
- `LayoutParams` структура — единая точка конфигурации.
- Smart-insert endpoint для добавления одиночного shape в существующую схему.
- Live verification на эталонном графе DRW-173.

### Out of scope (this iteration)

- libavoid runtime / любой WASM-router. Если elbow + smart layout не дотянут — отдельный follow-up.
- UI-панель параметров layout. Архитектурно поддерживаем, UI потом.
- Multi-bend orthogonal routes для одной стрелки — native elbow это single bend; нам этого достаточно при правильном layout.
- Auto-layout на каждый edit — explicitly NO.
- Pin discipline («user-pinned не двигаем при layout») — layout детерминирован, ручные позиции **перетираются** на следующем layout вызове. Сохранение позиций — задача edit-mode.

### Non-functional requirements

- **Determinism:** layout(topology, params) = always same result. Идемпотентность повторного вызова на свёрстанной схеме.
- **No regression** в существующих фичах (DRW-150 styling, DRW-158 virtual chain edges, DRW-164 frame geometry, DRW-172 anchor distribution).
- **Performance:** layout pass для 50 nodes / 100 edges < 500ms.

---

## 3. Architecture

### 3.1 Native elbow as canonical arrow

Все arrows в schema-frame v2 — `type:"arrow"`, `kind:"elbow"`. Никакого `routed-arrow` custom shape.

**Файлы для правок:**
- `apps/backend/src/domain/compile.ts:makeArrowShape` — `kind:"arc"` → `kind:"elbow"`.
- `apps/backend/src/routes/schema.ts:makeArrowShapeLocal` — то же.
- Bindings: `snap:"none"` (уже есть), `isPrecise:false` для свежесозданных, `isPrecise:true` после layout pass.

**ElbowArrowSnap enum** (для справки): `'center' | 'edge-point' | 'edge' | 'none'`. Используем `'none'`.

### 3.2 Layout pipeline (responsibilities per step)

`POST /api/layout?room=…&space=…` запускает sequential pipeline:

```
runLayout(store, params)
  ↓
Step 1: determineContainerDirections
  ↓ writes meta.didrawDirection per container if absent
Step 2: ELK positions (existing)
  ↓ writes shape.x/y per shape (parent-local)
Step 3: computeAnchors (DRW-172, existing)
  ↓ writes binding.props.normalizedAnchor + isPrecise=true
  ↓ writes arrow.meta.didrawSourcePort/TargetPort
Step 4: computeElbowMidpoints (NEW)
  ↓ writes arrow.props.elbowMidPoint per arrow
Step 5: reserveEdgeLabelSpacing (NEW — может потребовать re-run Step 2 если spacing меняет min edge length)
```

**Step 1 — Container direction heuristic.**

```typescript
function determineContainerDirection(container, edges, params): Direction {
  if (container.meta.didrawDirection) return container.meta.didrawDirection; // explicit
  // Count external edges crossing container border, group by cardinal side
  const incoming = countEdgesBySide(edges.incoming, container);  // { top, bottom, left, right }
  const outgoing = countEdgesBySide(edges.outgoing, container);
  // Pick direction such that dominant side has the appropriate child position
  const totalH = incoming.left + incoming.right + outgoing.left + outgoing.right;
  const totalV = incoming.top + incoming.bottom + outgoing.top + outgoing.bottom;
  if (totalH > totalV) return 'LR'; // children laid out horizontally
  return 'TB'; // default
}
```

**Step 4 — Elbow midpoint distribution.**

```typescript
function computeElbowMidpoints(arrows, anchors) {
  // Group arrows by (source.id, source.side, target.id, target.side)
  const groups = groupBy(arrows, a => `${a.src}:${a.srcSide}:${a.dst}:${a.dstSide}`);
  for (const [_, group] of groups) {
    const n = group.length;
    group.forEach((arrow, i) => {
      // Distribute midpoint values (i+1)/(n+1) — same pattern as DRW-172 anchor distribution
      arrow.props.elbowMidPoint = (i + 1) / (n + 1);
    });
  }
}
```

При `n=1` midpoint = 0.5 (дефолт, identity). При `n=2` midpoints = 0.33 / 0.67. И так далее.

**Step 5 — Edge label spacing reservation.**

```typescript
function reserveEdgeLabelSpacing(edges, params) {
  for (const edge of edges) {
    const labelText = extractLabelText(edge.arrow);
    if (!labelText) continue;
    const { width, height } = measureLabel(labelText, params.labelFont, params.labelMaxWidth);
    edge.minLength = width + 2 * params.labelMargin; // for horizontal sections
    // Inject into ELK input as org.eclipse.elk.spacing.nodeNode override for involved nodes
  }
}
```

`measureLabel` — DOM-measure через временный hidden node или canvas API.

### 3.3 LayoutParams structure

Единая точка конфигурации, передаётся через body endpoint'а или сохраняется в room/frame meta:

```typescript
type LayoutParams = {
  // Node sizing
  nodeMinWidth?: number;        // default 120
  nodeMinHeight?: number;       // default 60
  nodePadding?: number;         // default 16 (inside-shape inset for child layouts)

  // Container insets
  containerPadding?: number;    // default 24
  containerLabelHeight?: number;// default 32 (top-bar for label)

  // Edge spacing
  edgeSpacing?: number;         // default 16 (between parallel edges)
  edgeNodeSpacing?: number;     // default 20
  edgeLabelMaxWidth?: number;   // default 200
  edgeLabelMaxLines?: number;   // default 3
  edgeLabelMargin?: number;     // default 12
  edgeLabelFont?: string;       // default "12px draw"

  // Direction
  defaultDirection?: 'TB' | 'LR'; // default 'TB'
  autoDirectionEnabled?: boolean; // default true

  // Anchors
  anchorOffsetMode?: 'distribute' | 'center'; // default 'distribute' (DRW-172 behavior)

  // Midpoints
  midpointDistribution?: 'even' | 'fixed-0.5'; // default 'even'
};
```

Defaults живут в `apps/backend/src/domain/layout-params.ts`. При отсутствии параметра — default. Никаких хардкодов в pipeline.

### 3.4 Edit mode

- **No auto-layout** при любых mutations.
- Native tldraw arrow binding обеспечивает follow-behavior автоматически — никаких frontend handler'ов писать не надо.
- User может вручную:
  - Drag endpoint к конкретной точке shape edge (tldraw переключит `isPrecise:true` с нужным anchor).
  - Drag elbow bend handle (tldraw обновит `elbowMidPoint`).
  - Drag shape — binding автоматически recompute.

### 3.5 Smart-insert

`POST /api/smart-insert` (новый endpoint):

```typescript
{
  containerId: string;              // куда вставить
  size: { w: number; h: number };   // желаемый размер
  connectsTo?: string[];             // shape IDs которые будут связаны со вставляемым (для bias)
  biasDirection?: 'TB' | 'LR';      // для определения expansion направления
}
→
{
  ok: true;
  position: { x: number; y: number };  // позиция в parent-local координатах
  expansion?: { dw: number; dh: number };  // если parent был расширен
}
```

Алгоритм: grid-scan empty rectangle (см. research E7). Если пустого места нет — expand parent по `biasDirection` (или auto-determined). Если expansion требует cascading в grandparent — escalate to full `/api/layout` call.

**Light-режим:** не двигает соседних shapes (только new shape + optional parent w/h delta).

---

## 4. Implementation roadmap (phased)

### Phase 1 — Switch to elbow + measure-and-reserve labels
1. `compile.ts` + `schema.ts`: `kind: "elbow"`.
2. `apps/frontend/src/canvas/measure-label.ts` — DOM-based label measure utility.
3. `apps/backend/src/domain/layout.ts:reserveEdgeLabelSpacing` — inject min edge length в ELK.
4. **Live verification:** open DRW-173 mermaid sample → визуально сверить с эталоном.

### Phase 2 — Elbow midpoint distribution + container direction heuristic
1. `apps/backend/src/domain/midpoints.ts` — `computeElbowMidpoints`.
2. `apps/backend/src/domain/directions.ts` — `determineContainerDirection`.
3. Layout pipeline integration: вызвать после anchors.
4. **Live verification:** DRW-173 sample должен показать LR в Оркестрации (auto-flip).

### Phase 3 — LayoutParams parameterization
1. `apps/backend/src/domain/layout-params.ts` — defaults + validation.
2. Threading params через всю pipeline.
3. Optional override через body `/api/layout`.
4. Tests: same topology + different params → different visual results; same topology + same params → identical results (determinism).

### Phase 4 — Smart-insert endpoint
1. `apps/backend/src/routes/smart-insert.ts` — endpoint.
2. `apps/backend/src/domain/empty-space.ts` — `findEmptySlot` + expansion rule.
3. Tests: insertion into empty parent, partially filled, fully filled (expansion triggered).

### Phase 5 — Live verification + spec/quality review
1. Прогон DRW-173 эталонного графа end-to-end.
2. Сравнение pixel-by-pixel с `elk-ortho-reference-sample.png`.
3. Если визуально не дотягивает — open follow-up для libavoid-as-layout-hint (отдельный spec).
4. Spec/quality review (после Phase 1–4 completed) — единый проход.

---

## 5. Test plan

### Unit tests (per phase)
- `compile.test.ts` — kind:"elbow" writes correctly.
- `midpoints.test.ts` — distribution `(i+1)/(N+1)` для разных N, group-by соблюдается.
- `directions.test.ts` — heuristic выдаёт TB/LR в зависимости от edge topology.
- `empty-space.test.ts` — `findEmptySlot` находит / не находит / возвращает корректную позицию.
- `layout-params.test.ts` — validation + defaults.

### Integration tests
- `layout.test.ts`: same topology + same params → identical store mutation hash (idempotency check).
- `layout.test.ts`: param changes → expected position deltas.
- `schema.test.ts`: mermaid import → routed arrows are `kind:"elbow"`.

### Live verification (manual + scripted)
- DRW-173 sample room: arrow:N (native), routed-arrow:0, schema-container colors preserved, no crossings on internal edges.
- Visual diff vs `elk-ortho-reference-sample.png` — manual review by user.

---

## 6. Open questions / risks

1. **Label measurement timing.** Backend layout не имеет DOM. Возможные подходы:
   - Pre-compute labels на frontend перед каждым layout call (frontend → backend POST with label dimensions).
   - Backend embedded canvas-измеритель (через `bun` canvas-polyfill).
   - Эвристика на основе char-count + font-size без точного измерения.
   **Решение:** на Phase 1 идём через эвристику (`char_count * 7px` для шрифта 12px), потом улучшим. **Risk:** эвристика может занижать spacing для широких символов (cyrillic).

2. **Container label placement** (наблюдение из E6). Внутри 0.27.1 schema-container shape сам рендерит label сверху. Quick-test через `geo` shape с richText не воссоздаёт это поведение. Нужно проверить — это уже работает для schema-container? Если да — закрыто без изменений. Если нет — отдельная мелкая задача.

3. **Auto-direction heuristic не покрывает все случаи.** Если subgraph имеет и top-input и left-input одновременно (cross-container connections multiple ways) — heuristic выберет один, может оказаться не optimal. **Mitigation:** AI / user explicit override через `meta.didrawDirection`.

4. **Smart-insert cascading expansion.** Если parent внутри grandparent, и нет места — extend parent.h push'нет siblings. Это уже full layout. **Mitigation:** в Phase 4 явно escalate to full layout вместо partial expansion.

5. **libavoid-as-layout-hint as future option.** Если после Phase 5 visual quality не дотягивает — открываем отдельный spec на libavoid в layout-стадии (НЕ runtime), который подсказывает «развернуть container LR» / «переставить эти узлы». В этой итерации не делаем.

---

## 7. Out-of-band concerns

- **Branch policy:** работаем на `feature/drw-173-attempt-2`. Merge в main только после **user acceptance с live testing** (per `feedback-merge-needs-acceptance`).
- **Release tagging:** в конце фазы единый release tag (per `feedback-versioning-tags-only-on-release`).
- **Code review:** single pass после Phase 1–4 (per `feedback-batched-reviews`). Visual check controller-сам (per `feedback-no-subagent-screenshot-trust`).
