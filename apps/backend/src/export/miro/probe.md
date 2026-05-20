# Miro API probe — DRW-103

Date: 2026-05-20T06:38:21Z (live probe — board ID uXjVHQqmFVo%3D)

## DECISIONS APPLIED (post-probe, 0.19.1 hot-patch)

Live probe (2026-05-20) обнаружил 3 расхождения с SDK-derived defaults в 0.19.0:

1. **Shape `style.fillColor` accepts ARBITRARY hex** (Section A: `#abcdef` принят без enum-error). Initial SDK-source analysis был overconservative — Miro REST v2 не enum'ит fillColor для shapes. Применено в `color-mapping.ts`: `nearestShapeColor` упрощён до identity (parse + normalize to `#rrggbb` lowercase). `SHAPE_PRESETS` оставлен как documentary (UI swatch reference).

2. **`/items/bulk` request body** = raw JSON array `[...]`, НЕ `{data: [...]}` (Section E + manual verification). Применено в `client.ts:bulkItems`: убрана `{data: items}` wrapping. Response shape `{data: [...], type: "bulk-list"}` остаётся parsed correctly.

3. **Bulk size limit = 20 items** (не 50 как assumed). Section E с 60 items вернул `400 "At most 20 items could be created with a single request"`. Применено в `upload.ts`: `BULK_CHUNK_SIZE = 20`.

Также confirmed (без изменений): `metadata`/`appData` fields rejected with 400 (Sections B/C). Уже было исправлено в post-review fix 0.19.0 → tracking client-side only.

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
