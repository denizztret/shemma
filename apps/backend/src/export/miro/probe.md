# Miro API probe — DRW-103

Date: 2026-05-20T06:38:21Z (live probe — board ID uXjVHQqmFVo%3D)

## DECISIONS APPLIED (post-probe, 0.19.1 hot-patch)

Live probe (2026-05-20) обнаружил 3 расхождения с SDK-derived defaults в 0.19.0:

1. **Shape `style.fillColor` accepts ARBITRARY hex** (Section A: `#abcdef` принят без enum-error). Initial SDK-source analysis был overconservative — Miro REST v2 не enum'ит fillColor для shapes. Применено в `color-mapping.ts`: `nearestShapeColor` упрощён до identity (parse + normalize to `#rrggbb` lowercase). `SHAPE_PRESETS` оставлен как documentary (UI swatch reference).

2. **`/items/bulk` request body** = raw JSON array `[...]`, НЕ `{data: [...]}` (Section E + manual verification). Применено в `client.ts:bulkItems`: убрана `{data: items}` wrapping. Response shape `{data: [...], type: "bulk-list"}` остаётся parsed correctly.

3. **Bulk size limit = 20 items** (не 50 как assumed). Section E с 60 items вернул `400 "At most 20 items could be created with a single request"`. Применено в `upload.ts`: `BULK_CHUNK_SIZE = 20`.

Также confirmed (без изменений): `metadata`/`appData` fields rejected with 400 (Sections B/C). Уже было исправлено в post-review fix 0.19.0 → tracking client-side only.

### Post-0.19.1 follow-up probe (frame-child positioning, 0.19.2)

Live test показал что Miro child position = `relativeTo: "parent_top_left"`, не `parent_center` как предполагалось. Initial export после 0.19.1 fix вернул `400: "new position is outside of parent boundaries"`.

Manual verify: shape с `parent.id` + `position: {x: 0, y: 0}` → Miro reports `relativeTo: "parent_top_left"` в response. Child at frame center требует `position: { x: frame.w/2, y: frame.h/2 }`.

Применено в `upload.ts`: для frame children — `miroX = (childPageCenter.x) - parentPageTopLeft.x` (не parent-center). Centroid translation НЕ применяется к child position.

---

## Raw probe output

## A. Shape style.fillColor — invalid value response (probe enum)

```
{
  "id" : "3458764672508811629",
  "type" : "shape",
  "data" : {
    "content" : "probe",
    "shape" : "rectangle"
  },
  "style" : {
    "fillColor" : "#abcdef",
    "fillOpacity" : "1.0",
    "fontFamily" : "open_sans",
    "fontSize" : "14",
    "borderColor" : "#1a1a1a",
    "borderWidth" : "2.0",
    "borderOpacity" : "0.0",
    "borderStyle" : "normal",
    "textAlign" : "left",
    "textAlignVertical" : "top",
    "color" : "#1a1a1a"
  },
  "geometry" : {
    "width" : 100.0,
    "height" : 100.0
  },
  "position" : {
    "x" : 0.0,
    "y" : 0.0,
    "origin" : "center",
    "relativeTo" : "canvas_center"
  },
  "links" : {
    "self" : "https://api.miro.com/v2/boards/uXjVHQqmFVo%3D/shapes/3458764672508811629"
  },
  "createdAt" : "2026-05-20T06:38:21Z",
  "createdBy" : {
    "id" : "3458764651783224989",
    "type" : "user"
  },
  "modifiedAt" : "2026-05-20T06:38:21Z",
  "modifiedBy" : {
    "id" : "3458764651783224989",
    "type" : "user"
  }
}
```

## B. Field name probe — metadata

```
{
  "type" : "error",
  "code" : "2.0703",
  "context" : {
    "fields" : [ {
      "field" : "metadata",
      "message" : "Field [metadata] is not supported"
    } ]
  },
  "message" : "Invalid parameters",
  "status" : 400
}
```

## C. Field name probe — appData

```
{
  "type" : "error",
  "code" : "2.0703",
  "context" : {
    "fields" : [ {
      "field" : "appData",
      "message" : "Field [appData] is not supported"
    } ]
  },
  "message" : "Invalid parameters",
  "status" : 400
}
```

## D. GET items — verify which custom-field round-trips

```
{
  "size" : 1,
  "limit" : 50,
  "total" : 1,
  "data" : [ {
    "id" : "3458764672508811629",
    "type" : "shape",
    "data" : {
      "content" : "probe",
      "shape" : "rectangle"
    },
    "style" : {
      "fillColor" : "#abcdef",
      "fillOpacity" : "1.0",
      "fontFamily" : "open_sans",
      "fontSize" : "14",
      "borderColor" : "#1a1a1a",
      "borderWidth" : "2.0",
      "borderOpacity" : "0.0",
      "borderStyle" : "normal",
      "textAlign" : "left",
      "textAlignVertical" : "top",
      "color" : "#1a1a1a"
    },
    "geometry" : {
      "width" : 100.0,
      "height" : 100.0
    },
    "position" : {
      "x" : 0.0,
      "y" : 0.0,
      "origin" : "center",
      "relativeTo" : "canvas_center"
    },
    "links" : {
      "self" : "https://api.miro.com/v2/boards/uXjVHQqmFVo%3D/shapes/3458764672508811629"
    },
    "createdAt" : "2026-05-20T06:38:21Z",
    "createdBy" : {
      "id" : "3458764651783224989",
      "type" : "user"
    },
    "modifiedAt" : "2026-05-20T06:38:21Z",
    "modifiedBy" : {
      "id" : "3458764651783224989",
      "type" : "user"
    }
  } ],
  "links" : {
    "self" : "https://api.miro.com/v2/boards/uXjVHQqmFVo%3D/items?limit=50&cursor="
  },
  "type" : "cursor-list"
}
```

## E. Bulk size probe — POST /items/bulk with 60 shape items

```
{
  "type": "error",
  "code": "2.0703",
  "context": {
    "fields": [
      {
        "field": "",
        "message": "Unexpected type of value, expected of type [Object]"
      }
    ]
  },
  "message": "Invalid parameters",
  "status": 400
}

```

---

# DRW-111 Phase 0 probe (2026-05-23)

Live probe — board ID `uXjVHQqmFVo%3D`. Все артефакты cleaned up после каждой секции.

## F. Group widget API contract (`POST /v2/boards/{board_id}/groups`)

### F.1 Happy path — 2 items

Request:
```http
POST /v2/boards/uXjVHQqmFVo%3D/groups
Content-Type: application/json

{"data":{"items":["3458764672959437547","3458764672959437548"]}}
```

Response (HTTP 201):
```json
{
  "id": "3458764672959437667",
  "type": "group",
  "data": {
    "items": ["3458764672959437547", "3458764672959437548"]
  },
  "links": {
    "self": "https://api.miro.com/v2/boards/uXjVHQqmFVo%3D/groups/3458764672959437667"
  }
}
```

**Confirmed contract:**
- Body shape: `{"data":{"items":[<itemId>, ...]}}` — wrap field `data` REQUIRED.
- Items field name: `items` (NOT `itemIds`).
- Response fields: `id`, `type: "group"`, `data.items`, `links.self`. **No timestamps**, no `createdBy`/`modifiedBy`.
- `id` поле присутствует — используем для tracking.

### F.2 Nested group — REJECTED (404)

Request: pass an existing `groupId` (`3458764672959437667`) среди items together with a fresh shape id.

Response (HTTP **404**):
```json
{
  "type": "error",
  "code": "3.0201",
  "context": {"boardId":{"value":"uXjVHQqmFVo="}},
  "message": "Item not found",
  "status": 404
}
```

**Conclusion:** Miro **rejects** group ids inside `data.items`. Treats them as non-existent "items" (404, not 400 validation). Nested group flow (§ 8.4 spec) **must use flat fallback** — outer group's items list contains the **flattened** leaf-item ids (frame rectangles + descendant non-frame items), NOT inner group ids.

### F.3 Edge cases

| Case | Body | HTTP | Error |
|---|---|---|---|
| Empty items | `{"data":{"items":[]}}` | 400 | `"Group should have at least two items"` |
| Single item | `{"data":{"items":["<id>"]}}` | 400 | `"Group should have at least two items"` |
| No `data` wrap | `{"items":[<id>]}` | 400 | `"Field [data] of type [Object] is required"` |
| `itemIds` field name | `{"data":{"itemIds":[<id>]}}` | 400 | `"Field [data.items] of type [Array] is required"` |

**Minimum items per group: 2.** Frame-as-shape mode must skip group creation для frames с 0 или 1 child (frame rectangle alone не образует group).

### F.4 Implications for spec § 8.3 / § 8.4

- Spec § 8.3 (Pass C creates groups inner-first then outer) — sequence stays, но **outer call's items array** = leaf-items-only (flat). Inner `groupId` НЕ передаётся в outer.
- Spec § 8.4 `if nested accepted/rejected` — answer locked: **rejected → use flat fallback** (described as second outcome in § 8.4).
- Edge: if a frame contains exactly 0 or 1 child (frame rectangle alone) — **skip** `POST /groups` call (would 400). Tracking schema: no `groups[frameId]` entry → frame stays as a plain rectangle on the board.

## G. Z-order via bulk POST

Goal: verify Miro bulk creation preserves array index → z-order (later in array → on top).

### G.1 Live test

Bulk POST'нул `[{content:"bottom", grey 200x200}, {content:"top", red 100x100 inside}]`.

Returned ids:
- `3458764672959524758` — "bottom" (created first in array)
- `3458764672959524759` — "top" (created second in array)

`createdAt` для обоих идентичный (`2026-05-23T12:57:38Z`) — Miro assignsне различает microsecond, но id **strictly monotonic** (758 < 759, matches array order).

### G.2 Z-order control endpoints — NONE exposed

Probe results — Miro REST v2 НЕ exposes z-order через REST:

| Attempted | HTTP | Error |
|---|---|---|
| `PATCH /shapes/{id}` with `{"position":{"bringToFront":true}}` | 400 | `"Field [position.bringToFront] is not supported"` |
| `PATCH /shapes/{id}` with `{"zIndex":999}` | 400 | `"Field [zIndex] is not supported"` |
| `GET /items/{id}` response | n/a | No `zIndex` / `zOrder` field returned |

Item shape (per GET): `{id, type, data, style, geometry, position{x,y,origin,relativeTo}, links, createdAt, createdBy, modifiedAt, modifiedBy}` — z-order entirely absent.

### G.3 Inference

Miro Web UI рендерит items в **creation order** (newer ids on top). Это:
- Confirmed indirectly через GET `/items` ordering (sorted by `id` ascending).
- Documented Miro behavior — bulk POST array order = id assignment order = z-order semantics.
- НЕТ другого endpoint для управления z-order — единственный mechanism это creation sequence.

### G.4 Decision for spec § 8.5

**Array order = creation order = z-order (later = on top).** Pass A1 (frames) BEFORE Pass A2 (children) гарантирует frame rectangles ниже children в z-order. Внутри A1 — **depth-first outer-first** (outer frame создаётся first → ниже) — этого достаточно.

**Fallback PATCH/bringToBack flow НЕ требуется** — endpoint не существует. Если этой стратегии окажется недостаточно в production (frames оказываются поверх children), единственный fallback — **DELETE + re-POST** в правильном порядке (heavyweight, defer как separate task если когда-либо понадобится).

Spec § 8.5 remains valid; § 14 Q8 — **resolved with array-order + creation-order strategy, no PATCH alternative needed (none exists)**.

## H. tldraw 5.x named-color hex palette

**Source file:** `node_modules/.bun/@tldraw+editor@5.0.0+ab629783a4f35bff/node_modules/@tldraw/editor/src/lib/editor/managers/ThemeManager/defaultThemes.ts` (DEFAULT_THEME, exported by `tldraw` package).

Extracted `colors.light.<name>.solid` (the strict equivalent of "stroke/border color" в tldraw shapes; matches `getColorValue(_, name, 'solid')` documented behavior).

### H.1 Diff vs spec § 4.1

| Color | Spec v0.3 | tldraw 5.0.0 actual | Match | Notes |
|---|---|---|---|---|
| black | `#1d1d1d` | `#1d1d1d` | ✓ | — |
| grey | `#adb5bd` | `#9fa8b2` | ✗ | spec значение похоже на Mantine palette grey-4; tldraw cooler grey |
| light-violet | `#c4a1ff` | `#e085f4` | ✗ | spec from Mantine violet-3; tldraw — magenta-leaning pink |
| violet | `#ae3ec9` | `#ae3ec9` | ✓ | — |
| blue | `#4263eb` | `#4465e9` | ✗ | very close (≤6 in each channel), но не identical |
| light-blue | `#4dabf7` | `#4ba1f1` | ✗ | small delta (≤10 channels) |
| yellow | `#ffc078` | `#f1ac4b` | ✗ | tldraw желтее/насыщеннее (orange undertone) |
| orange | `#f76707` | `#e16919` | ✗ | tldraw less saturated orange |
| green | `#099268` | `#099268` | ✓ | — |
| light-green | `#40c057` | `#4cb05e` | ✗ | tldraw чуть mut'нее |
| light-red | `#ff8787` | `#f87777` | ✗ | tldraw чуть darker |
| red | `#e03131` | `#e03131` | ✓ | — |

8/12 mismatches. Spec значения — clearly Mantine-derived (pre-tldraw-5.0 palette); actual tldraw 5.0.0 — independent palette.

### H.2 Recommendation

**UPDATE `TLDRAW_NAMED_TO_HEX` table in spec § 4.1** to the actual tldraw 5.0.0 light-theme `solid` values:

```ts
export const TLDRAW_NAMED_TO_HEX: Record<TldrawNamedColor, string> = {
  "black":        "#1d1d1d",
  "grey":         "#9fa8b2",
  "light-violet": "#e085f4",
  "violet":       "#ae3ec9",
  "blue":         "#4465e9",
  "light-blue":   "#4ba1f1",
  "yellow":       "#f1ac4b",
  "orange":       "#e16919",
  "green":        "#099268",
  "light-green":  "#4cb05e",
  "light-red":    "#f87777",
  "red":          "#e03131",
};
```

### H.3 Optional follow-up — fill variant

tldraw shapes имеют дополнительные variant: `fill` (часто = `solid`), `semi`, `pattern`, `noteFill`. Для DRW-111 `borderColor` / `strokeColor` использует `solid`. `fillColor` при `fill: "semi"` / `"pattern"` — spec mapping (§ 4.3) использует SAME color hex с opacity 0.5; альтернативно можно использовать tldraw `colors.light.<name>.semi` (precomputed lighter shade). DECISION для DRW-111: остаёмся на solid+opacity (simpler, matches arbitrary-fill semantics, не требует extra table); semi variant — possible future improvement.

## I. Miro strokeCap enum

### I.1 SDK enum list

Source: `https://raw.githubusercontent.com/miroapp/api-clients/main/packages/miro-api/model/connectorStyle.ts` (Miro REST v2 OpenAPI-generated).

`StartStrokeCapEnum` === `EndStrokeCapEnum` (identical), 16 values:

```
none, stealth, rounded_stealth,
diamond, filled_diamond,
oval, filled_oval,
arrow, triangle, filled_triangle,
erd_one, erd_many, erd_only_one, erd_zero_or_one, erd_one_or_many, erd_zero_or_many
```

Plus sentinel `unknown` (SDK only — server returns этого если value не recognized).

### I.2 Live verification — spec values FAIL

Tested 8 connector POSTs (8 cap pairs × 2 caps each = 16 cap usages):

| start | end | HTTP | Reason |
|---|---|---|---|
| `diamond_filled` | `arrow_filled` | **400** | spec values — INVALID |
| `oval_filled` | `rectangle_filled` | **400** | spec values — INVALID |
| `rectangle` | `none` | **400** | `rectangle` — INVALID |
| `unicode_arrow` | `arrow` | **400** | `unicode_arrow` — INVALID |
| `filled_diamond` | `filled_triangle` | 201 | ✓ |
| `filled_oval` | `stealth` | 201 | ✓ |
| `diamond` | `triangle` | 201 | ✓ |
| `oval` | `rounded_stealth` | 201 | ✓ |
| `none` | `arrow` | 201 | ✓ |
| `stealth` | `none` | 201 | ✓ |
| `erd_one` | `erd_many` | 201 | ✓ |
| `erd_only_one` | `erd_zero_or_one` | 201 | ✓ |
| `erd_one_or_many` | `erd_zero_or_many` | 201 | ✓ |

**4/8 spec mappings REJECTED.** Server error message подтвердил enum:
```
Unexpected value [diamond_filled], expected one of: [none, stealth, rounded_stealth, diamond, filled_diamond, oval, filled_oval, arrow, triangle, filled_triangle, erd_one, erd_many, erd_only_one, erd_zero_or_one, erd_one_or_many, erd_zero_or_many]
```

### I.3 Spec § 7.1 — REQUIRES REWRITE

Текущая mapping (8 invalid + `bar`/`pipe` неоднозначны):

```ts
case "triangle": return "arrow_filled";    // ✗ should be "filled_triangle"
case "square":   return "rectangle_filled"; // ✗ no "rectangle*" in enum — needs different target
case "dot":      return "oval_filled";      // ✗ should be "filled_oval"
case "diamond":  return "diamond_filled";   // ✗ should be "filled_diamond"
case "inverted": return "unicode_arrow";    // ✗ no such value
case "bar":      return "rectangle";        // ✗ no "rectangle"
case "pipe":     return "rectangle";        // ✗ no "rectangle"
```

### I.4 New mapping (verified 9-row table)

Final tldraw arrowhead → Miro strokeCap:

| tldraw | Miro strokeCap | Notes |
|---|---|---|
| `none` | `none` | exact |
| `arrow` | `arrow` | exact |
| `triangle` | `filled_triangle` | tldraw triangle = filled |
| `square` | `none` | no square/rectangle cap in Miro; fallback to plain line (`stealth` would imply arrow head — wrong) |
| `dot` | `filled_oval` | dot = filled circle |
| `diamond` | `filled_diamond` | exact concept |
| `inverted` | `arrow` | no inverted-direction cap in Miro; degrade to plain arrow (tldraw inverted = arrow facing backward, visually similar to plain arrow for end users) |
| `bar` | `none` | no bar cap; degrade to plain line |
| `pipe` | `none` | no pipe cap; degrade to plain line |

`square`/`bar`/`pipe` → `none` chosen over fake mapping: Miro caps available — round, pointed, ER-symbols only; никакая из них visually не соответствует bar/pipe/square. Lose decoration > misleading. Documentation note для release notes: "tldraw `square`/`bar`/`pipe` arrowheads экспортируются без head (Miro не поддерживает rectangular caps)".

`inverted` → `arrow` instead of `stealth`: tldraw `inverted` рисует filled triangle обращённый назад. Miro `stealth` (default) ближе по геометрии, но смотрит вперёд — `arrow` (открытая стрелка) более neutral fallback. Acceptable since `inverted` редко используется в архитектурных диаграммах (per spec § 7.3).

## J. Miro fontFamily + text widget color

### J.1 SDK fontFamily list (30 values)

Source: `https://raw.githubusercontent.com/miroapp/api-clients/main/packages/miro-api/model/shapeStyleForCreate.ts` + `model/textStyle.ts` (identical enum):

```
arial, abril_fatface, bangers, eb_garamond, georgia, graduate, gravitas_one,
fredoka_one, nixie_one, open_sans, permanent_marker, pt_sans, pt_sans_narrow,
pt_serif, rammetto_one, roboto, roboto_condensed, roboto_slab, caveat,
times_new_roman, titan_one, lemon_tuesday, roboto_mono, noto_sans, plex_sans,
plex_serif, plex_mono, spoof, tiempos_text, formular
```

### J.2 Spec § 6.1 values confirmed

- `open_sans` ✓ present
- `times_new_roman` ✓ present
- `roboto_mono` ✓ present

### J.3 Casual scripts for `draw` mapping

Available casual / handwriting fonts:
- `caveat` — flowing script (likely best for `draw` per spec § 6.1 hint)
- `permanent_marker` — bold marker style
- `lemon_tuesday` — script
- `bangers` — comic/poster (less applicable)

Live-test: created shape с `fontFamily: "caveat"` → HTTP 201, server echoed `"fontFamily": "caveat"` без modification. Confirmed производственное значение.

**Recommendation:** `draw` → `caveat` (replace spec's `open_sans` fallback in § 6.1). `caveat` best emotional match для tldraw handwriting feel; `permanent_marker` тоже работает, но slightly heavier.

### J.4 Final fontFamily mapping (4-row)

| tldraw font | Miro fontFamily | Notes |
|---|---|---|
| `draw` | `caveat` | handwriting / casual script |
| `sans` | `open_sans` | default fallback |
| `serif` | `times_new_roman` | exact |
| `mono` | `roboto_mono` | exact |

### J.5 Text widget color field

Live-test 2 variants:

| Request | HTTP | Result |
|---|---|---|
| `POST /texts {"style":{"color":"#ff0000"}}` | 201 | accepted; response echoes `style.color = "#ff0000"` |
| `POST /texts {"style":{"textColor":"#ff0000"}}` | 400 | `"Field [style.textColor] is not supported"` |

**Locked: field name = `color`** (for both text widgets AND shape widgets — same SDK type pattern `TextStyle.color` / `ShapeStyleForCreate.color`). Spec § 4.6 prediction `color` (not `textColor`) — CORRECT, no spec change required.

Note: text widget also exposes `fillColor` (background fill); for tldraw `text` shape (no background) — оставляем `fillColor` unset → defaults to transparent (`fillOpacity: 0`).
