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
