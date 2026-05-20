# Miro API probe — DRW-103

**Research findings (static doc analysis — live probe deferred)**

---

## STATUS

Live API probe (scripts/probe-miro.sh) is **deferred** — user did not provide a Miro developer token during this session. All findings below are derived from **static analysis** of:

- Miro Node.js API client source: `https://github.com/miroapp/api-clients` (branch `main`)
- Specifically: `packages/miro-api/model/shapeStyleForCreate.ts` and `packages/miro-api/model/shapeCreateRequest.ts`
- Miro Web SDK reference: `https://developers.miro.com/docs/websdk-reference-board`

The probe script `scripts/probe-miro.sh` is ready to run when the user provides:
1. A Miro developer token stored in `~/.config/shemma/config.json`
2. A sandbox board ID in `~/.config/shemma/probe-board-id.txt`

Live verification is recommended before shipping 0.19.0 to confirm enum values haven't changed.

---

## EXTRACTED: SHAPE_PRESETS (16 hex)

**Source:** `https://github.com/miroapp/api-clients/blob/main/packages/miro-api/model/shapeStyleForCreate.ts`

The `fillColor` JSDoc in the official Miro Node.js SDK documents exactly 16 accepted hex values plus a default:

```
/**
 * Fill color for the shape.
 * Hex values: `#f5f6f8` `#d5f692` `#d0e17a` `#93d275` `#67c6c0` `#23bfe7`
 *             `#a6ccf5` `#7b92ff` `#fff9b1` `#f5d128` `#ff9d48` `#f16c7f`
 *             `#ea94bb` `#ffcee0` `#b384bb` `#000000`
 * Default: #ffffff.
 */
```

**Complete SHAPE_PRESETS array (17 entries — 16 listed presets + default white):**

| # | Hex | Visual description |
|---|-----|-------------------|
| 1 | `#ffffff` | White (default) |
| 2 | `#f5f6f8` | Light grey |
| 3 | `#d5f692` | Light lime green |
| 4 | `#d0e17a` | Yellow-green |
| 5 | `#93d275` | Medium green |
| 6 | `#67c6c0` | Teal |
| 7 | `#23bfe7` | Cyan/light blue |
| 8 | `#a6ccf5` | Light blue |
| 9 | `#7b92ff` | Blue-violet |
| 10 | `#fff9b1` | Light yellow (Post-it) |
| 11 | `#f5d128` | Yellow |
| 12 | `#ff9d48` | Orange |
| 13 | `#f16c7f` | Salmon/red-pink |
| 14 | `#ea94bb` | Pink |
| 15 | `#ffcee0` | Light pink |
| 16 | `#b384bb` | Purple |
| 17 | `#000000` | Black |

**Note on count:** spec §5.3 says "16 preset hex values" — this refers to the 16 explicitly enumerated non-default values. `#ffffff` is additionally valid as the API default. The SHAPE_PRESETS array in `color-mapping.ts` should include all 17 to enable correct nearest-neighbour matching (including white as a target).

**Confidence:** HIGH — values come from the official auto-generated SDK that tracks the Miro REST API v2 OpenAPI spec. Cross-confirmed by both `shapeStyle.ts` and `shapeStyleForCreate.ts`.

---

## EXTRACTED: tracking field name = NONE (REST v2 has no inline metadata field)

**Source:** `https://github.com/miroapp/api-clients/blob/main/packages/miro-api/model/shapeCreateRequest.ts`

The `ShapeCreateRequest` TypeScript class (auto-generated from Miro OpenAPI spec v2) has exactly these fields:

```typescript
export class ShapeCreateRequest {
  'data'?: ShapeDataForCreate
  'style'?: ShapeStyleForCreate
  'position'?: PositionChange
  'geometry'?: Geometry
  'parent'?: Parent
}
```

**There is NO `metadata` field and NO `appData` field** on `ShapeCreateRequest`. The Miro REST API v2 for shape creation does not support inline custom metadata in the CREATE payload.

Similarly, `GenericItem` (the response type) has no `metadata` or `appData` field:
```typescript
export class GenericItem {
  'id': string
  'data'?: WidgetDataOutput
  'style'?: ...
  'position'?: Position
  'geometry'?: Geometry
  'createdAt'?: Date
  'createdBy'?: CreatedBy
  'modifiedAt'?: Date
  'modifiedBy'?: ModifiedBy
  'parent'?: Parent
  'links'?: WidgetLinks
  'type': string
}
```

**What metadata options exist in Miro:**

1. **Web SDK only — `setMetadata`/`getMetadata`**: The Miro Web SDK exposes `item.setMetadata(key, value)` / `item.getMetadata(key)` for card, connector, embed, image, preview, shape, sticky note, and text items. Storage limit: **6 KB per item** (per `https://developers.miro.com/docs/websdk-reference-board`). This is a **Web SDK abstraction** and does NOT correspond to a REST API field in the shape CREATE payload. It's managed via separate SDK-internal REST calls not surfaced in the public v2 items API.

2. **App Cards only — `CustomField` array**: `AppCardDataChanges` has a `fields: CustomField[]` property. App cards are a distinct item type requiring app authentication — not applicable to regular shapes.

3. **Tags**: Items can have tags, but tags are board-level entities (not per-item key-value), unrelated to tracking.

**Decision (per spec §10.2 fallback):** The REST API does NOT support inline `metadata` or `appData` field in `POST /shapes`. The idempotency tracking story via Miro item metadata is **NOT implementable** via the shape CREATE payload in REST v2.

**Architectural implication for builder.ts:** Remove the `metadata: { shemmaId, ... }` field from `MiroShapeCreate` payload. Tracking (shemma elementId ↔ Miro item ID) must be maintained **exclusively client-side** in `room.meta.miroExports` (§10.1). The Miro item has no back-reference to shemma. This is acceptable for 0.19.0 scope (update path is out of scope anyway per §2.2).

**Confidence:** HIGH — confirmed from official SDK source. Live probe section B/C/D of `probe-miro.sh` will confirm that `metadata`/`appData` fields are silently ignored or return 400 error.

---

## EXTRACTED: bulk chunk size = 50 (no documented limit, conservative default retained)

**Source:** `https://developers.miro.com/reference/bulk-create-items` (fetched 2026-05-20)

The `POST /v2/boards/{board_id}/items/bulk` endpoint documentation does **not** state a maximum number of items per request. The response codes documented are `201`, `400`, `429` — no `413 Payload Too Large` mentioned.

The official Miro Node.js SDK does not expose a bulk limit constant.

**Decision:** Retain `BULK_CHUNK_SIZE = 50` as the conservative default (community practice). Live probe section E of `probe-miro.sh` will test with 60 items to confirm 50 has margin.

**Confidence:** MEDIUM — no documented limit found; 50 is an empirical community convention. Requires live verification before shipping.

---

## DECISION: no-metadata strategy for builder.ts

Based on the tracking field research above:

- `metadata` field → **NOT supported** in REST v2 shape CREATE.
- `appData` field → **NOT supported** in REST v2 shape CREATE.

**builder.ts strategy for 0.19.0:** Do NOT include any metadata/tracking field in Miro item CREATE payloads. The Miro item will have no back-reference to shemma. Idempotency tracking is 100% client-side via `room.meta.miroExports[boardId].items[elementId] = miroItemId`.

This resolves the §13 OQ#2 blocker. The "future update path" mentioned in §2.2 (PATCH existing Miro items) will require either:
- Using Web SDK `setMetadata` in a separate call after item creation (requires a browser-side Miro app, not feasible for backend export).
- Maintaining the client-side tracking map and looking up miroItemId by elementId before PATCH.
- OR a separate REST endpoint if Miro exposes item metadata in a future API revision.

For 0.19.0 scope (append-only export), this is not a blocker.

---

## DECISION: borderColor-only fallback — NOT needed

The 16 shape fillColor presets ARE confirmed from SDK source. `borderColor-only` fallback (spec §5.3 fallback path) is **not needed**. Proceed with full `fillColor` nearest-neighbour mapping in `color-mapping.ts`.

---

## Sources

| Source | URL | Date accessed |
|--------|-----|---------------|
| Miro SDK `shapeStyleForCreate.ts` | https://github.com/miroapp/api-clients/blob/main/packages/miro-api/model/shapeStyleForCreate.ts | 2026-05-20 |
| Miro SDK `shapeStyle.ts` | https://github.com/miroapp/api-clients/blob/main/packages/miro-api/model/shapeStyle.ts | 2026-05-20 |
| Miro SDK `shapeCreateRequest.ts` | https://github.com/miroapp/api-clients/blob/main/packages/miro-api/model/shapeCreateRequest.ts | 2026-05-20 |
| Miro SDK `genericItem.ts` | https://github.com/miroapp/api-clients/blob/main/packages/miro-api/model/genericItem.ts | 2026-05-20 |
| Miro Web SDK reference (board) | https://developers.miro.com/docs/websdk-reference-board | 2026-05-20 |
| Miro bulk create endpoint | https://developers.miro.com/reference/bulk-create-items | 2026-05-20 |
