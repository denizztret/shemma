# Visual Fidelity v2 — Miro Export Style Expansion (Design)

**Version:** 0.3
**Date:** 2026-05-22
**Status:** draft v0.3 — user review pending
**Target release:** 0.22.0 (MINOR — additive style props + frame-mode change-of-default)
**Tracking:** Backlog [[DRW-111]]
**Predecessor:** [[2026-05-19-export-miro-design]] (DRW-103 — structural fidelity, shipped 0.20.x)
**Related:** [[feedback-product-vision-bidirectional]] (bidirectional sync — visual fidelity снижает manual-cleanup при reverse-import)

## Changelog

- v0.3 (2026-05-22) — review pass against actual code (5 P1/P2 findings + Miro endpoint confirmation):
  - **§12 переписан**: migration story исправлена под фактический **append-only** export (re-export создаёт duplicate Miro items, tracking merges new ids поверх старых; old Miro items остаются на board). Старое утверждение "tracking ids persist, no dupes" было ошибочным.
  - **§8.7 переписан**: tracking schema выровнена с актуальной `MiroExportsMap[boardId]` (`boardName?`, `lastExportedAt`, `items`, `connectors?`); добавляется optional `groups?: Record<elementId, groupId>`. Поля `schemaVersion`/`shapes` (мои выдумки) убраны.
  - **§8.3 + §8.4 переписаны**: pass-модель приведена в соответствие с фактическим A1/A2 split в `upload.ts:181`. A1 bulk POST = frame rectangles (depth-first); A2 bulk POST = non-frame children; затем `POST /v2/boards/{id}/groups` (inner first, outer last).
  - **§8.5 z-order упрощён**: гарантируется A1/A2 split (frames created before children → Miro creation-order semantics ставит rectangles ниже). Removed prior "single bulk depth-first" pseudocode.
  - **§4.6 + CHANGELOG draft в §10.3**: text shape уже реализован (`builder.ts:112`, wired в `upload.ts:249`); scope = "style wire", не "add text export". "was unsupported" removed.
  - **§4.5 sticky fallback**: добавлен sticky-specific fallback `"yellow"` (когда `props.color` undefined). Generic `tldrawNamedToHex(undefined) → black` для shapes остаётся, для sticky используется выделенный path.
  - **§8.6 endpoint**: путь `POST /v2/boards/{board_id}/groups` + наличие `data` body field — **confirmed** через Miro official docs (https://developers.miro.com/reference/creategroup, fetched 2026-05-22). Точная shape `data` object (items field name, nested groups acceptance) остаётся probe Phase 0.
  - **§14 Q4** сужен до details (body shape + nested + limits), endpoint path removed from unknowns.
- v0.2 (2026-05-22) — self-review pass:
  - § 4.6 + § 5.3 + § 6.3 **новые**: standalone tldraw `text` shape mapping (отдельный typeName, не `geo`).
  - § 5.1 расширен: `tldrawSizeToStickyFontSize` для Miro sticky enum (14/24/36/48/72) — sticky использует свой fontSize scale.
  - § 4.5 уточнено: disambiguation `typeName:"shape",type:"note"` (sticky widget) vs `geo` с `meta.role:"note"` (обычный geo с label).
  - § 4.4 связь с § 6 явно показана: connector `style.fontFamily` тоже wire'ится через `tldrawFontToFamily`.
  - § 4.3 footnote: `pattern` и `semi` visually identical в Miro export — задокументировать в release notes.
  - § 8.4 numeric ordering для nested example — clarity.
  - § 10.3 CHANGELOG draft: `Breaking` → `Changed (default behavior)` (визуальный change-of-default, не API breaking).
  - § 13 implementation phases переписан: probe (Group widget contract + z-order + tldraw hex palette + Miro fontFamily/strokeCap enum) — **Phase 0 pre-impl**, не часть test plan. Plan не может писаться до probe results.
  - § 14 Q6 (inverted arrowhead) — locked default `unicode_arrow`; revisit только если probe shows missing.
  - § 14 **новый Q8**: verify Miro bulk-POST z-order = array index order. Если нет — обсудить PATCH/bringToBack alternative.
  - § 2 Non-goals: добавлен явный пункт "no `frameMode` opt-in param" — single default, lock'нут в § 10.1.
- v0.1 (2026-05-22) — initial draft after brainstorm session + frame-mode policy Q&A:
  - Frame-mode locked: `shape` default (rectangle с label, без Miro frame widget); children группируются через `POST /v2/boards/{id}/groups`; fill `#ffffff` solid; border `normal` solid; tldraw color наследуется как `borderColor`.
  - Color/size/font/arrowhead mapping tables — initial draft. Точные tldraw 5.x hex и Miro strokeCap enum помечены как implementation-step verification.

---

## 1. Motivation

DRW-103 (shipped 0.20.x) перенёс **структурную** fidelity в Miro: shapes + connectors + frame nesting + text-align + dash style. Доска визуально читается, но **палитра tldraw теряется** — все элементы рисуются с дефолтным чёрным border'ом и белым fill'ом, дефолтным fontFamily, одной толщиной border'а независимо от tldraw `size` props.

tldraw 5.x поддерживает rich visual palette:
- **12 named colors** (`black/grey/light-violet/violet/blue/light-blue/yellow/orange/green/light-green/light-red/red`)
- **4 sizes** (`s/m/l/xl`) — управляют fontSize, strokeWidth, padding
- **4 fonts** (`draw/sans/serif/mono`)
- **4 fill modes** (`none/semi/solid/pattern`)
- **9 arrowheads** (`none/arrow/triangle/square/dot/diamond/inverted/bar/pipe`)

Miro REST v2 поддерживает **все необходимые knobs**:
- shape `style.fillColor` принимает arbitrary hex (probe results, [[miro-sdk-reference]]).
- `style.fontFamily` — 30+ enum values.
- `style.fontSize` — numeric string, 8..60.
- `style.borderWidth` / connector `style.strokeWidth` — numeric string, 1..24.
- connector `style.startStrokeCap` / `endStrokeCap` — 15+ enum values.

После DRW-111 экспорт визуально match'ит canvas: цвета сохраняются, толщины пропорциональны, заливки повторяются, стрелки помечены типом.

### Side-benefit: reverse-import quality (forward-looking)

[[feedback-product-vision-bidirectional]] описывает long-term vision — bidirectional sync (Miro → shemma). Чем больше визуальной информации мы переносим **в** Miro сейчас, тем меньше manual reconstruction потребуется при reverse-direction в будущем (через GET `/v2/boards/{id}/items` → infer tldraw color/size/etc.). DRW-111 — это groundwork для reverse-import без формального scope expansion.

---

## 2. Goals & Non-goals

### Goals

1. tldraw 12 named colors → Miro hex для `borderColor`, conditional `fillColor`, connector `strokeColor`, sticky `fillColor` (через ближайший Miro sticky enum).
2. tldraw 4 sizes → Miro `fontSize` + `borderWidth` (shapes) + `strokeWidth` (connectors).
3. tldraw 4 fonts → Miro `fontFamily` enum.
4. tldraw 9 arrowheads → Miro `startStrokeCap` / `endStrokeCap`.
5. shemma boundary frames → **Miro rectangle + group widget** (новый default), вместо Miro `frame` widget.
6. Connector styling (color/size/cap) не должно ломать `expandImplicitArrows` orchestrator из 0.20.1.

### Non-goals

- **Pattern fill** (`tldraw fill: "pattern"`) — Miro не поддерживает диагональную штриховку из коробки; fallback на `fillOpacity: 0.5` (≈ semi).
- **Custom rotation handling** — tldraw `rotation` уже маппится в DRW-103 § 5.3 (Miro `rotation`).
- **Frame-as-frame backward-compat mode** для существующих export'ов — все old exports остаются valid (tracking id persists), новые export'ы используют новый default. Spec не предусматривает migration старых Miro-board'ов.
- **Sticky pattern/font customization** — Miro sticky notes имеют узкий enum (16 colors, ~6 fontSizes). Маппим best-effort, без новых features.
- **Reverse Miro → shemma import** — отдельный future spec (DRW-XXX); DRW-111 не добавляет endpoint'ов в эту сторону.

### Out-of-scope (deferred to follow-ups)

- AI-driven color suggestion (DRW-112 prompts).
- Layout direction switch (DRW-100).
- Miro `card` widget mapping for richer metadata.
- **`frameMode` opt-in parameter** — single default `shape` без user-facing toggle. См. § 10.1.

---

## 3. Current state recap

DRW-103 shipped (refs `apps/backend/src/export/miro/`):
- `builder.ts` — `buildShapePayload`, `buildConnectorPayload`, `buildStickyNotePayload`, `buildFramePayload`, `applyPositionAndParent`.
- `color-mapping.ts` — `SHAPE_PRESETS`, `STICKY_COLOR_RGB`, `nearestStickyColor`, `nearestShapeColor`, `parseHex`. **Currently все shapes используют identity hex** (т.е. `meta.fillHex` если есть, иначе ничего); `borderColor` и `fontFamily` — Miro defaults.
- `upload.ts` — orchestrator: Pass A1 (frames) → Pass A2 (rest) → Pass B (connectors) bulk POST. `expandImplicitArrows` восстанавливает arrows из tldraw binding records.
- `coords.ts` — frame-child position math (`parent_top_left`).
- `tracking.ts` — `room.meta.miroExports[boardId]` идемпотентность.

**Tests:** `builder.test.ts`, `color-mapping.test.ts`, `upload.test.ts`, `integration.test.ts`, `tracking.test.ts`, `coords.test.ts` — ~80 tests.

DRW-111 расширяет всё outgoing-mapping добавлением new helper'ов и wire'инг'ом в `build*Payload`. Pass-структура и tracking — без изменений.

---

## 4. Block 1 — Color mapping

### 4.1 Helpers (new in `color-mapping.ts`)

```ts
export type TldrawNamedColor =
  | "black" | "grey" | "light-violet" | "violet" | "blue" | "light-blue"
  | "yellow" | "orange" | "green" | "light-green" | "light-red" | "red";

/** tldraw 5.x light-theme defaults. Values verified against tldraw source. */
export const TLDRAW_NAMED_TO_HEX: Record<TldrawNamedColor, string> = {
  "black":        "#1d1d1d",
  "grey":         "#adb5bd",
  "light-violet": "#c4a1ff",
  "violet":       "#ae3ec9",
  "blue":         "#4263eb",
  "light-blue":   "#4dabf7",
  "yellow":       "#ffc078",
  "orange":       "#f76707",
  "green":        "#099268",
  "light-green":  "#40c057",
  "light-red":    "#ff8787",
  "red":          "#e03131",
};

export function tldrawNamedToHex(name: string | undefined): string {
  if (!name) return TLDRAW_NAMED_TO_HEX.black;
  return TLDRAW_NAMED_TO_HEX[name as TldrawNamedColor] ?? TLDRAW_NAMED_TO_HEX.black;
}
```

**Implementation note:** точные значения hex для tldraw 5.x палитры верифицируются на implementation step против tldraw source (`@tldraw/tldraw/src/lib/shapes/shared/colors.ts` или эквивалент) — указанные выше — рабочие defaults из памяти, требуют sanity-check'а перед merge.

### 4.2 Wire в `buildShapePayload`

```ts
// before (current):
const style: ShapeStyle = {
  fontFamily: "open_sans",
  textAlign: tldrawAlignToMiro(geo.props.align),
  textAlignVertical: tldrawValignToMiro(geo.props.verticalAlign),
  // borderColor/fillColor not set → Miro defaults (black border, fillOpacity 0)
};

// after (DRW-111):
const colorHex = tldrawNamedToHex(geo.props.color);
const style: ShapeStyle = {
  fontFamily: tldrawFontToFamily(geo.props.font),     // Block 3
  fontSize:   tldrawSizeToFontSize(geo.props.size),   // Block 2 (string)
  textAlign:        tldrawAlignToMiro(geo.props.align),
  textAlignVertical:tldrawValignToMiro(geo.props.verticalAlign),
  borderColor: colorHex,
  borderWidth: tldrawSizeToBorderWidth(geo.props.size), // Block 2
  ...fillStyle(geo.props.fill, colorHex),               // см. § 4.3
};
```

### 4.3 Fill mapping

`geo.props.fill: "none" | "semi" | "solid" | "pattern"` → Miro `fillColor` + `fillOpacity`:

| tldraw fill | Miro `fillColor` | Miro `fillOpacity` |
|---|---|---|
| `none` | _(omit)_ | `"0.0"` |
| `semi` | `colorHex` | `"0.5"` |
| `solid` | `colorHex` | `"1.0"` |
| `pattern` | `colorHex` | `"0.5"` (degrade to semi; Miro нет diag-fill) |

> **Note:** `pattern` и `semi` будут визуально неотличимы в Miro export. Задокументировать в release notes как known limitation.

```ts
function fillStyle(fill: string, hex: string): Partial<ShapeStyle> {
  switch (fill) {
    case "solid":   return { fillColor: hex, fillOpacity: "1.0" };
    case "semi":    return { fillColor: hex, fillOpacity: "0.5" };
    case "pattern": return { fillColor: hex, fillOpacity: "0.5" };
    case "none":
    default:        return { fillOpacity: "0.0" };
  }
}
```

### 4.4 Wire в `buildConnectorPayload`

```ts
const colorHex = tldrawNamedToHex(arrow.props.color);
return {
  ...existing,
  style: {
    ...existing.style,
    strokeColor: colorHex,
    strokeWidth: tldrawSizeToStrokeWidth(arrow.props.size), // Block 2
    fontFamily:  tldrawFontToFamily(arrow.props.font),       // Block 3 — label font on connector
    fontSize:    tldrawSizeToFontSize(arrow.props.size),     // Block 2
  },
};
```

### 4.5 Wire в `buildStickyNotePayload`

**Disambiguation:** в tldraw 5.x существуют два варианта "note":
- `typeName: "shape", type: "note"` — sticky-note widget (имеет `props.color/size/font/align/richText`); экспортируется как Miro **sticky note** через `buildStickyNotePayload`.
- `typeName: "shape", type: "geo", meta.role: "note"` — обычный geo shape с shemma-specific role; экспортируется как Miro **shape** через `buildShapePayload` (без специальной обработки).

DRW-111 styling применяется к обоим path'ам — первый через `buildStickyNotePayload`, второй автоматически через § 4.2.

Miro sticky `fillColor` — narrow enum (16 values). Sticky имеет **отдельный fallback** `"yellow"` (current `builder.ts:99` behavior — sticky без `meta.fillHex` рисуется жёлтой). DRW-111 сохраняет этот fallback при отсутствии `props.color`:

```ts
// Helper для sticky-specific fallback (новый):
function stickyFillColor(note: RawShape): string {
  const named = note.props?.color as string | undefined;
  if (!named) return "yellow"; // preserve legacy default
  return nearestStickyColor(tldrawNamedToHex(named));
}

// Wire:
return {
  ...existing,
  style: {
    ...existing.style,
    fillColor: stickyFillColor(note),
    fontFamily: tldrawFontToFamily(note.props.font),
    // sticky fontSize — отдельный helper, см. § 5.1 (tldrawSizeToStickyFontSize)
  },
};
```

> **Why distinct fallback:** generic `tldrawNamedToHex(undefined) → black` (§ 4.1) корректен для shapes (любой shape без явного color рисуется чёрным border'ом), но для sticky'ев black `fillColor` = чёрный квадратик — не desired. Legacy yellow это affordance Miro UX (sticky = yellow по умолчанию в whiteboard convention).

### 4.6 Wire в `buildTextPayload` (standalone tldraw `text`)

Tldraw `typeName: "shape", type: "text"` — отдельный widget от `geo` (без border, только text content). **Уже реализован** в DRW-103: `apps/backend/src/export/miro/builder.ts:112` (`buildTextPayload`), wired в A2 dispatch на `upload.ts:249`. Текущая реализация ставит `style: {}` — без color/font/size. DRW-111 scope = **wire styling**, не add export.

```ts
// Extend existing buildTextPayload (builder.ts:112):
const colorHex = tldrawNamedToHex(text.props.color);
return applyPositionAndParent({
  type: "text",
  data: { content: pickRichText(text.props) },  // existing helper
  style: {
    color:      colorHex,                          // Miro text widget использует `color`, не `borderColor`
    fontFamily: tldrawFontToFamily(text.props.font),
    fontSize:   tldrawSizeToFontSize(text.props.size),
    textAlign:  tldrawAlignToMiro(text.props.textAlign), // text widget не имеет verticalAlign
  },
  geometry: { width: w },                           // existing
}, ctx);
```

**Implementation note:** verify имя поля для color в Miro text widget style (`color` vs `textColor`) на impl step против `textStyle.ts` SDK source ([[miro-sdk-reference]] § 3).

---

## 5. Block 2 — Size mapping

### 5.1 Helpers

```ts
export type TldrawSize = "s" | "m" | "l" | "xl";

export function tldrawSizeToFontSize(size: string | undefined): string {
  switch (size) {
    case "s":  return "12";
    case "l":  return "20";
    case "xl": return "30";
    case "m":
    default:   return "14";
  }
}

export function tldrawSizeToBorderWidth(size: string | undefined): string {
  switch (size) {
    case "s":  return "1.0";
    case "l":  return "3.0";
    case "xl": return "4.0";
    case "m":
    default:   return "2.0";
  }
}

export function tldrawSizeToStrokeWidth(size: string | undefined): string {
  return tldrawSizeToBorderWidth(size); // identical mapping
}

/**
 * Miro sticky note использует свой fontSize scale — enum 14|24|36|48|72.
 * Не reuse через tldrawSizeToFontSize т.к. sticky values другие.
 */
export function tldrawSizeToStickyFontSize(size: string | undefined): string {
  switch (size) {
    case "s":  return "14";
    case "l":  return "36";
    case "xl": return "48";
    case "m":
    default:   return "24";
  }
}
```

### 5.2 Effect

Applied via wiring shown в § 4.2 / § 4.4. No new orchestrator changes; helpers — pure functions, fully testable.

### 5.3 Sticky note size wire

```ts
// в buildStickyNotePayload (extends § 4.5):
return {
  ...existing,
  style: {
    ...existing.style,
    fontSize: tldrawSizeToStickyFontSize(note.props.size),
  },
};
```

### 5.4 Text widget size wire

Standalone `text` shape (§ 4.6) использует обычный `tldrawSizeToFontSize` (shape scale, не sticky scale).

---

## 6. Block 3 — Font mapping

### 6.1 Helper

```ts
export type TldrawFont = "draw" | "sans" | "serif" | "mono";

export function tldrawFontToFamily(font: string | undefined): string {
  switch (font) {
    case "draw":  return "open_sans";       // best-effort match to handwriting feel
    case "serif": return "times_new_roman";
    case "mono":  return "roboto_mono";
    case "sans":
    default:      return "open_sans";
  }
}
```

**Verified enum:** значения `open_sans`, `times_new_roman`, `roboto_mono` присутствуют в Miro `shapeStyleForCreate.ts` JSDoc (см. [[miro-sdk-reference]] §3 SDK source). Точный enum-list проверяется на implementation step.

**Implementation note about `draw`:** Miro нет hand-written-style font'а в shape style enum. `open_sans` — neutral fallback. Альтернатива — `caveat` (если у Miro есть casual script font; verify на impl step). Решение фиксируется первым PR'ом фазы.

### 6.2 Effect

Wire'ится в:
- `buildShapePayload.style.fontFamily` (§ 4.2)
- `buildStickyNotePayload.style.fontFamily` (§ 4.5)
- `buildConnectorPayload.style.fontFamily` (§ 4.4 — для label text на стрелке; Miro connector style supports fontFamily)
- `buildTextPayload.style.fontFamily` (§ 4.6 — standalone text widgets)

### 6.3 Text widget font wire

Включено в § 4.6 (`buildTextPayload`) — standalone tldraw text shapes используют ту же mapping table что shapes/sticky/connector.

---

## 7. Block 4 — Arrowhead mapping

### 7.1 Helper

```ts
export type TldrawArrowhead =
  | "none" | "arrow" | "triangle" | "square" | "dot"
  | "diamond" | "inverted" | "bar" | "pipe";

export function tldrawArrowheadToStrokeCap(head: string | undefined): string {
  switch (head) {
    case "none":     return "none";
    case "triangle": return "arrow_filled";   // closest match — Miro нет "triangle"
    case "square":   return "rectangle_filled";
    case "dot":      return "oval_filled";
    case "diamond":  return "diamond_filled";
    case "inverted": return "unicode_arrow";  // approximate; verify on impl
    case "bar":      return "rectangle";
    case "pipe":     return "rectangle";
    case "arrow":
    default:         return "arrow";
  }
}
```

**Miro strokeCap enum** содержит ~15+ значений (verified against `connectorStyle.ts` SDK source, [[miro-sdk-reference]]). Финальная mapping table уточняется на impl step против live SDK enum — выше указаны best-fit guesses.

### 7.2 Wire

```ts
// in buildConnectorPayload:
return {
  ...existing,
  style: {
    ...existing.style,
    startStrokeCap: tldrawArrowheadToStrokeCap(arrow.props.arrowheadStart),
    endStrokeCap:   tldrawArrowheadToStrokeCap(arrow.props.arrowheadEnd),
  },
};
```

### 7.3 Edge case — `inverted`

tldraw `inverted` рисует стрелку, указывающую обратно (start-direction triangle on arrow line). Miro SDK enum не содержит точного эквивалента. **Decision (locked, can revisit):** map to `unicode_arrow` (closest). Если Miro отрендерит plain stroke без head — acceptable; tldraw `inverted` редко используется в архитектурных диаграммах.

---

## 8. Block 5 — Frame mode (frame-as-shape default)

### 8.1 Decision summary (locked via Q&A 2026-05-22)

| Parameter | Decision |
|---|---|
| Default mode | **Shape** (rectangle с label, без Miro `frame` widget) |
| Children grouping | **POST /v2/boards/{id}/groups** — rectangle + все children в одной Miro group |
| Fill | `fillColor: "#ffffff"`, `fillOpacity: "1.0"` |
| Border | `borderStyle: "normal"` (solid) |
| Border color | tldraw `props.color` → hex (inherits через Block 1) |
| Border width | tldraw `props.size` → "1.0" / "2.0" / "3.0" / "4.0" (через Block 2) |
| Title placement | `data.content: name`, `textAlign: "center"`, `textAlignVertical: "top"` |
| Title font | default (open_sans), size "14" (m-equivalent) |
| children `parent.id` | **not set** (absolute positions) |

### 8.2 Why "shape" вместо "frame"

| Aspect | Miro `frame` widget (current) | Miro `shape` + group (new default) |
|---|---|---|
| Nesting depth | 1 level cap (hard Miro constraint) | Unlimited (recursive groups) |
| Visual | Titlebar + grey background | Whitebox с label, clean appearance |
| Children layout | `parent.id` + relativeTo coord | Absolute, no parent linkage |
| Drag together | Yes (Miro UI moves frame and children) | Yes via `POST /v2/groups` widget |
| Children outside frame | Implicitly excluded | Possible (children могут уехать при edit) |
| Manual UX in Miro | Lock-step, очень structured | Flexible, freeform-feel |

shemma `boundary` semantics — это **logical** контейнер, не physical lock-step group. tldraw frames в нашем use-case рендерят более похоже на whitebox с label, чем на explicit Miro frame widget. Choice `shape` align'ит export с original visual intent.

### 8.3 Order of operations

Pass-модель **сохраняет существующий A1/A2 split** из `upload.ts:181`. Изменения относятся только к **что** мы строим в A1 (раньше — `frame` widget, теперь — `shape` rectangle) и добавляют **новый Pass C** для groups.

1. **Pass A1** (existing, изменяется payload type) — bulk POST `/items/bulk` всех frame **rectangles** (раньше — Miro frame widgets). Frames заполняются в depth-first order (outermost first). Returned ids → `frameMap: elementId → miroId`. Commit'ятся chunk-by-chunk через `commitBoardExport` (по существующему flow).
2. **Pass A2** (existing) — bulk POST `/items/bulk` всех **non-frame** shapes/notes/text. Children рисуются ПОСЛЕ frames → оказываются поверх в Miro creation-order z-order. `parentMiroId` для children **не передаётся** (frame-as-shape mode → absolute positions, см. § 8.1). Returned ids → `itemMap`.
3. **Pass B** (existing) — `postConnector` per arrow. Без изменений в DRW-111 (только styling в payload).
4. **Pass C** (NEW) — для каждого frame `POST /v2/boards/{board_id}/groups` с body `{ data: { items: [frameMiroId, ...descendantMiroIds] } }`. Inner frames первыми, outer последними (см. § 8.4). Returned `groupId` → `room.meta.miroExports[boardId].groups[frameElementId] = groupId` через `commitBoardGroupExport` (новая function в `tracking.ts`).

> **Note on rename:** "Pass A1" в коде обращается к frames; функциональная роль остаётся та же, но контент payload меняется (frame widget → rectangle shape). Никакого `containers` rename не делаем — overcomplicates.

### 8.4 Nested frames

Outer frame F1 содержит inner frame F2 и shape S1:

```
F1
├── F2
│   └── S2
└── S1
```

Sequence of API calls:

1. **Pass A1** — bulk POST `[F1.rect, F2.rect]` (depth-first order). Returns `frameMap = { F1: m_F1, F2: m_F2 }`.
2. **Pass A2** — bulk POST `[S1, S2]` (non-frames). Returns `itemMap = { S1: m_S1, S2: m_S2 }`.
3. **Pass C inner first** — `POST /groups` body `{ data: { items: [m_F2, m_S2] } }` → returns `g_F2`.
4. **Pass C outer** — `POST /groups` body `{ data: { items: [m_F1, g_F2, m_S1] } }` → returns `g_F1`.
5. **Tracking commit** — `groups: { F1: g_F1, F2: g_F2 }` через `commitBoardGroupExport`.

**Nested group acceptance** (passing `g_F2` в outer's items array) — Phase 0 probe (§ 14 Q4). Два возможных outcome'а:

- **Если Miro принимает nested groups** (preferred): outer group содержит inner group as single item. Drag F1 в Miro UI → перемещает rectangle F1 + всю inner group g_F2 (rect F2 + S2) + S1. Inner-only drag (F2) → перемещает только g_F2 contents, оставляя F1-rect и S1 на месте. **Это desired UX.**
- **Если Miro отвергает nested groups**: fallback — outer group содержит **flattened items** `[m_F1, m_F2, m_S2, m_S1]` (skip nested groupId, dereference в children). Trade-off: теряем independent inner drag (drag F1 двигает всё дерево; drag F2 невозможен как отдельное действие), но preserve overall containment + Miro accept.

Code path выбирается dynamically на основе probe outcome (один if-branch в orchestrator). Detection: try nested first; on 400 with specific error code — flatten retry.

### 8.5 Z-order strategy

Z-order **гарантируется существующим A1/A2 split**: Pass A1 (frame rectangles) выполняется до Pass A2 (children), поэтому frames создаются в Miro раньше и оказываются ниже в z-order (Miro creation-order semantics, locked при probe Phase 0 § 14 Q8).

Никакой specific in-array ordering не требуется — даже если внутри A2 children идут в случайном порядке относительно их frames, frames уже созданы в A1.

Внутри A1 frames заполняются в **depth-first** order (outermost first → inner last). Это обеспечивает что outer frame rectangle оказывается ниже inner frame rectangle при их пересечении (e.g. inner frame внутри outer frame).

```ts
// в pass A1 payload builder:
function buildFrameRectangles(elements: Element[]): MiroBulkItem[] {
  return framesInDepthFirstOrder(elements).map(buildShapeForFrame);
}
```

`framesInDepthFirstOrder` — новая helper в `upload.ts`, walks через elements deepest-first parent traversal. Existing code (`upload.ts:181`) уже обрабатывает frames как separate list — нужно дополнить sortировкой.

**Edge case:** если Miro z-order **не** matches creation order (probe Q8 fails) — fallback: после Pass A1 sequential `PATCH /items/{id}` с `position.origin` или dedicated `bringToBack` endpoint для каждого frame rectangle. Решение откладывается до probe outcome.

### 8.6 Group widget API contract

**Endpoint confirmed** через official Miro REST v2 reference (https://developers.miro.com/reference/creategroup, accessed 2026-05-22):

```http
POST /v2/boards/{board_id}/groups
Content-Type: application/json
Authorization: Bearer <token>

{
  "data": { ... }
}
```

Body required field `data` (object). Response status `201 Group created` / `400 Malformed request` / `404 Not found` / `429 Too many requests`.

**Still to probe (Phase 0 § 14 Q4):**
- Точная shape `data` object: предположение — `{ items: ["miroId1", "miroId2", ...] }`; альтернатива — `{ itemIds: [...] }` или nested `{ data: { type, items } }`. Resolve через "Try It!" в interactive API explorer (developers.miro.com) или test call.
- Response body shape — нужен `id` field для tracking (предположение `{ id: "3458...=", type: "group", data: {...} }`).
- Min/max items per group.
- **Nested group acceptance** — pass returned `groupId` в outer call's items array. Если accepted → § 8.4 sequence работает; если rejected → fallback to flat list (см. § 8.4).
- Empty items / single item handling — likely 400 / 201 respectively.

Add probe section в `apps/backend/src/export/miro/probe.md` Section F (groups widget).

### 8.7 Tracking schema additions

Текущая фактическая shape (`apps/backend/src/types.ts:31`):

```ts
export type MiroExportsMap = Record<
  string,                       // boardId
  {
    boardName?: string;
    lastExportedAt: string;
    items: Record<string, string>;       // shape elementId → Miro item id
    connectors?: Record<string, string>; // arrow elementId → Miro connector id
  }
>;
```

DRW-111 добавляет один optional field:

```ts
export type MiroExportsMap = Record<
  string,
  {
    boardName?: string;
    lastExportedAt: string;
    items: Record<string, string>;
    connectors?: Record<string, string>;
    groups?: Record<string, string>;     // NEW: frame elementId → Miro group widget id
  }
>;
```

Дополнительно: новая function `commitBoardGroupExport(room, { boardId, groupMappings })` в `tracking.ts`, симметричная `commitBoardExport`. Merge semantics: новые group ids overwrite старые для тех же frame elementIds (идемпотентно).

Backward-compat: 0.20.x export'ы не имеют `groups` field — re-export merges new groups in без conflict. Existing readers (frontend gallery, doctor command) могут не знать про новое поле — `groups?: optional` обеспечивает graceful ignore.

---

## 9. Block 6 — Verify styled connectors don't break expandImplicitArrows

### 9.1 Background

`expandImplicitArrows` (introduced 0.20.1) — orchestrator восстанавливает arrows из tldraw binding records, которые user не выбрал явно но shapes на обоих концах присутствуют в selection. Function в `apps/backend/src/export/miro/upload.ts`.

### 9.2 Concern

В 0.20.x все connectors имели default Miro style (black, width 2, arrow cap). DRW-111 добавляет per-arrow `strokeColor`, `strokeWidth`, `startStrokeCap`, `endStrokeCap`. Если `expandImplicitArrows` строит payload отдельным path'ом (не через `buildConnectorPayload`), styled props не попадут.

### 9.3 Verification

Code-review step (no logic change required если path единый):

1. Trace `expandImplicitArrows` → confirm uses `buildConnectorPayload(arrow, ...)`. Если да — DRW-111 styling автоматически работает.
2. Если path bypasses `buildConnectorPayload` — refactor для re-use.

Add test в `upload.test.ts`:
```ts
test("expandImplicitArrows preserves styled connectors", () => {
  // tldraw bindings where source/target in selection but arrow not selected
  // verify resulting Miro connector payload has strokeColor/strokeWidth/strokeCaps
});
```

---

## 10. API surface changes

### 10.1 `runMiroExport()` — no signature change

Frame-mode change-of-default не требует нового параметра — старое поведение (`frame` widget) удаляется. Если кто-то нуждается в backward-compat — параметр `frameMode?: "shape" | "frame"` можно добавить в будущем (DRW-XXX), default остаётся `"shape"`.

**Decision (locked):** **NO** `frameMode` opt-in в DRW-111. Single default. Уменьшает API surface, simplify orchestrator, reduce test combinations. Если требование вернётся — отдельный issue.

### 10.2 MCP `shemma_export_miro` tool — no schema change

Existing tool params (`boardId`, `roomId`, `elementIds[]`, `dryRun`) остаются без изменений. Internal builder получит новый styling — observable change только в Miro output, не в tool API.

### 10.3 CHANGELOG entry будет:

```
## 0.22.0 — TBD — DRW-111 Visual fidelity v2

### Changed (default behavior)
- Frame export switched from Miro `frame` widget to `shape + group` mode by default.
  Note: export is **append-only** — re-export creates NEW Miro items each time (no
  Miro-side dedup; tracking merges fresh ids over previous). Old Miro frame widgets
  AND any prior exported items are NOT removed automatically — user must clean up
  manually in Miro UI before re-export if duplicates undesired.
- `pattern` fill mode renders identical to `semi` in Miro (Miro lacks diagonal-fill).

### Added
- tldraw 12 named colors → Miro hex (borderColor / fillColor / strokeColor).
- tldraw 4 sizes → Miro fontSize / borderWidth / strokeWidth (and sticky fontSize scale).
- tldraw 4 fonts → Miro fontFamily (shapes / stickies / connectors / standalone text).
- tldraw 9 arrowheads → Miro startStrokeCap / endStrokeCap.
- POST /v2/boards/{id}/groups widget creation for frame containers (frame-as-shape mode).
- room.meta.miroExports[boardId].groups tracking field (optional, additive).
- Styling propagation для standalone tldraw `text` shape (`builder.ts:buildTextPayload`)
  — color / fontFamily / fontSize / textAlign. Mapping был неактивен в 0.20.x.
```

`Breaking` уровень — фрейм-mode is observable change, но без code-level API change. PATCH-level не подходит (visual diff at default behavior); MINOR корректен.

---

## 11. Test plan

### 11.1 Unit (pure helpers)

`color-mapping.test.ts`:
- `tldrawNamedToHex` — все 12 colors → expected hex.
- `tldrawNamedToHex(undefined)` → defaults to `black` hex.
- `tldrawNamedToHex("unknown-color")` → defaults to `black` (graceful fallback).

`builder.test.ts`:
- `tldrawSizeToFontSize` — все 4 sizes + undefined.
- `tldrawSizeToBorderWidth` / `tldrawSizeToStrokeWidth` — все 4 sizes + undefined.
- `tldrawFontToFamily` — все 4 fonts + undefined.
- `tldrawArrowheadToStrokeCap` — все 9 arrowheads + undefined.
- `fillStyle("solid", "#abc")` → `{ fillColor: "#abc", fillOpacity: "1.0" }`. Same для `semi` / `pattern` / `none`.
- `buildShapePayload(geoShape)` — full payload assertion с styling.
- `buildConnectorPayload(arrow)` — assertion с strokeCap pair.
- `buildStickyNotePayload(note)` — assertion использует `nearestStickyColor` после `tldrawNamedToHex`.

### 11.2 Frame-mode unit

New file `frame-mode.test.ts` (или в `builder.test.ts`):
- `buildShapeForFrame(frame)` — `data.content === frame.props.name`, fillColor white, borderStyle normal, borderColor inherits from `props.color`.
- Z-order: when given mixed elements, frames приходят first in pass-A payload.
- Nested frames: outer frame index < inner frame index в same payload.

### 11.3 Orchestrator integration

`upload.test.ts` (extend):
- Full flow: 1 frame + 2 children → Bun.serve mock Miro returns ids → orchestrator calls `POST /groups` с правильным items array.
- Nested frames: 2 group POST calls в правильном порядке (inner group created first, then outer wraps it + outer rect + outer-only children).
- Тracking persistence: после complete export `room.meta.miroExports[boardId].groups` содержит mapping для каждого frame.

### 11.4 Probe section (live verify required)

`probe.md` Section F (NEW):
- `POST /v2/boards/{board-id}/groups` с body `{ data: { items: [valid_item_id_1, valid_item_id_2] } }` — confirm response shape, `id` field.
- Nested groups: pass `groupId` в outer call — confirm acceptance.
- Empty items array — error code.
- Group with single item — accepted or rejected?
- Max items per group?

Outcome → ADR-snippet в `probe.md` Section F, ссылка в spec impl notes.

### 11.5 Live E2E (manual smoke)

`docs/manual-tests/drw-111-visual-fidelity.md` (NEW):
- Setup: tldraw canvas с примером — 3 boundaries (nested), 8 shapes (различные colors/sizes/fonts), 5 arrows (различные colors/sizes/arrowheads).
- Steps: `⌘⇧E` → export modal → execute.
- Verify in Miro board (M.Shemma):
  - Цвета shapes соответствуют tldraw colors.
  - Sizes proportional (size:l shape видимо thicker border).
  - Frames — whitebox rectangles с labels (НЕ Miro frame widgets).
  - Drag frame → children movement together (group widget works).
  - Nested frame — drag inner вне outer → outer не двигается (independent group).

---

## 12. Migration & backward compatibility

### 12.1 Append-only export — фактическое поведение

**Important context (corrects v0.2 assumption):** текущий `runMiroExport` ([upload.ts:181](apps/backend/src/export/miro/upload.ts:181)) — **append-only**. Per call:

- Каждый shape/note/text/frame создаётся через `bulkItems()` — Miro генерирует новые ids.
- Каждый arrow создаётся через `postConnector()` — новый Miro connector id.
- `commitBoardExport` ([tracking.ts:41](apps/backend/src/export/miro/tracking.ts:41)) **сливает** new mappings поверх существующих в `room.meta.miroExports[boardId].items`/`connectors`: `items[elementId] = newMiroId` overwrites prior value.

**Implication:** re-export tabs того же canvas в тот же board создаёт **duplicate Miro items на board**. Tracking теряет ссылки на старые ids — они становятся "orphaned" (присутствуют в Miro, но shemma больше не знает про них). Это existing behavior 0.20.x, DRW-111 его НЕ меняет.

### 12.2 DRW-111 impact

DRW-111 не меняет append-only nature. Следствия для users, чьи 0.20.x export'ы существуют:

- **Старые frame widgets** на доске остаются. Re-export создаёт новый набор rectangles + groups + duplicate children. Старые frame widgets и старые duplicate children — manual cleanup в Miro UI.
- **Старые connectors** остаются. Re-export создаёт новые. Manual cleanup.
- Tracking after re-export — только new ids; orphan ссылки на старые элементы отсутствуют в `room.meta.miroExports`.

Документация в release notes (см. § 10.3 Changed (default behavior) выше) предупреждает явно.

### 12.3 Alternative considered & deferred

**Idempotent re-export** (PATCH existing items вместо POST new) — отдельная feature, не часть DRW-111:

- Требует sync diff logic (определить какие elementIds уже в tracking → PATCH; новые → POST; removed → DELETE).
- Conflict resolution: что делать если user удалил Miro item manually между export'ами? PATCH 404 → fall back to POST?
- Defer как [[DRW-XXX]] (создать отдельную issue после DRW-111 ship'а).

### 12.4 schemaVersion considerations

Actual `MiroExportsMap[boardId]` shape **не имеет** `schemaVersion` field ([types.ts:31](apps/backend/src/types.ts:31)) — additive `groups?` не требует introduction нового field. Existing readers (frontend gallery, MCP, doctor) игнорируют unknown fields через TS structural typing — graceful.

Если future schema changes потребуют versioning, добавим `schemaVersion?: number` как optional field в тот же миграционный цикл.

---

## 13. Implementation phases (high-level)

Detailed plan — в отдельном document'е `docs/superpowers/plans/2026-05-22-drw-111-visual-fidelity-plan.md` (Phase 2 of workflow). **Plan не пишется до завершения Phase 0 probe** — assumptions могут потребовать spec revision (v0.3).

### Phase 0 — Pre-impl probe (BLOCKING for plan writing)

Verify все unknowns **до** написания plan'а. Update spec → v0.3 если обнаружены discrepancies. ~2-3h:

0.1. **Group widget API details** (§ 8.6 / § 14 Q4) — endpoint path confirmed; probe details: exact `data` object shape (items field name), response shape (id field), nested groups support, min/max items, empty/single-item handling.
0.2. **Z-order via bulk POST** (§ 8.5 / § 14 Q8) — confirm Miro bulk creation preserves array index → z-order (later = on top). Если нет — design PATCH/bringToBack alternative.
0.3. **tldraw 5.x hex palette** (§ 4.1 / § 14 Q1) — verify все 12 named colors против tldraw source. Update `TLDRAW_NAMED_TO_HEX` table.
0.4. **Miro strokeCap enum** (§ 7.1 / § 14 Q2) — confirm 9 mapping targets все present в production Miro enum. Lock final table.
0.5. **Miro fontFamily enum** (§ 6.1 / § 14 Q3) — confirm `open_sans`, `times_new_roman`, `roboto_mono` все production-valid.
0.6. **`draw` font fallback** (§ 6.1 / § 14 Q5) — check if Miro имеет casual script font (e.g. `caveat`). If yes — update mapping.

Outcome: spec v0.3 (если updates) + Section F в `probe.md`.

### Phase 1 — Implementation (after Phase 0 + plan approval)

1. **Helpers (pure functions + unit tests)** — `tldrawNamedToHex`, `tldrawSizeToFontSize`, `tldrawSizeToBorderWidth`, `tldrawSizeToStrokeWidth`, `tldrawSizeToStickyFontSize`, `tldrawFontToFamily`, `tldrawArrowheadToStrokeCap`, `fillStyle`. ~2-3h.
2. **Wire helpers in builders** — `buildShapePayload`, `buildConnectorPayload`, `buildStickyNotePayload`, `buildTextPayload` (создать если отсутствует). ~2-3h.
3. **Frame-as-shape implementation** — new `buildShapeForFrame`, refactor pass-A ordering (frames first, depth-first). ~3-4h.
4. **Group widget orchestrator** — POST /groups call after Pass A, tracking schema extension. ~3-4h.
5. **Nested frames integration test** — Bun.serve mock Miro, full bulk + groups flow. ~2h.
6. **Connector style verification** (§ 9) — code review + test для expandImplicitArrows. ~1h.
7. **Manual E2E smoke** (§ 11.5) — real Miro board, side-by-side с canvas screenshot. ~1h.
8. **Release** — CHANGELOG, version bump (0.21.9 → 0.22.0), publish-release.sh, push. ~30min.

**Total estimate:** Phase 0 ~2-3h + Phase 1 ~14-18h = **~16-21h** active dev.

---

## 14. Open questions (verify on impl)

Все вопросы блокированы Phase 0 probe (§ 13). Updates landing as spec v0.3 if any discrepancy found.

1. **tldraw 5.x exact hex palette** — values в § 4.1 — best-guess defaults. Probe step: open tldraw editor, inspect color picker SVG / source. Update table в spec via v0.3 revision if discrepancy.
2. **Miro `strokeCap` exact enum** — § 7.1 mapping — guesses based on SDK source observation. Probe step: GET an existing connector after creating each enum value манually in Miro UI. Update table в spec via v0.3 revision if discrepancy.
3. **Miro `fontFamily` exact list** — § 6.1 — verify `open_sans`, `times_new_roman`, `roboto_mono` все present в Miro production enum. Alternative naming (e.g. `times_roman`) — flag if different.
4. **POST /v2/boards/{board_id}/groups body/response details** — endpoint path **confirmed** через Miro reference (§ 8.6); body's `data` object shape остаётся probe-required: точное имя поля для items array (предполагается `items`), response shape (`id` field for tracking), nested group acceptance, min/max items, empty/single-item handling.
5. **`draw` font fallback** — § 6.1 — verify if Miro имеет `caveat`, `permanent_marker`, or другой casual script font. If yes — use that вместо `open_sans` для `draw` mapping (lock decision в impl step #1 above).
6. **Inverted arrowhead** — § 7.3 — **DECISION LOCKED:** default `unicode_arrow`. Revisit только если Phase 0 probe shows `unicode_arrow` отсутствует в production enum; в таком случае fallback на `arrow` без модификации direction (acceptable graceful degrade).
7. **Group widget включает label?** — Logical answer: yes, rectangle IS part of the group (its first item). Verify: clicking on label area selects the group в Miro UI. Probe-step.
8. **Miro bulk-POST z-order** — § 8.5 — assumes order in payload array = z-order (earlier → bottom). Verify в Phase 0: create 3-shape bulk where shape[2] covers shape[0] xy-wise; confirm shape[2] visually on top. Если нет — design PATCH `position.origin: "bringToBack"` flow для frame rectangles или separate POST'ы с явным `zIndex`.

---

## 15. References

- DRW-103 spec: [[2026-05-19-export-miro-design]] — § 5.3 nearest-color mapping (extends here).
- DRW-103 plan: `docs/superpowers/plans/2026-05-20-export-miro-plan.md` — task structure baseline.
- Live probe results: `apps/backend/src/export/miro/probe.md` — fillColor enum freedom; metadata field absence; appData field absence; bulk array shape.
- Memory: [[miro-sdk-reference]] — entry points для Miro REST / SDK research without re-discovery.
- Memory: [[feedback-product-vision-bidirectional]] — long-term motivation (visual fidelity ↔ reverse-import quality).
- Memory: [[reference-tldraw-cheatsheet]] — tldraw 5.x props reference (`docs/references/tldraw-cheatsheet.md`).
- tldraw color source: `@tldraw/tldraw` (npm) — `dist-cjs/lib/shapes/shared/colors.js` (or ESM equivalent) — light theme map.
- Miro SDK source: `https://github.com/miroapp/api-clients/tree/main/packages/miro-api/model` — `shapeStyleForCreate.ts`, `connectorStyle.ts`, `stickyNoteStyle.ts`, `groupCreateRequest.ts`.

---

## 16. Acceptance summary (для review)

Spec считается accepted когда user подтверждает:

- [ ] Block 1-4 mapping tables — рабочая отправная точка для plan'а (точные значения verify на impl step).
- [ ] Block 5 frame-mode policy match'ит решения из Q&A 2026-05-22.
- [ ] Block 6 verification step adequate (no code change required если path единый).
- [ ] § 10.1 — no `frameMode` opt-in в DRW-111 (single default).
- [ ] § 12.1 migration story (no auto-delete old frames) acceptable.
- [ ] Open questions § 14 — список комплектен; ни одна "blocking unknown" не пропущена.

После approval: переход в Phase 2 — написание plan'а в `docs/superpowers/plans/2026-05-22-drw-111-visual-fidelity-plan.md` (детальный task breakdown с TDD steps).
