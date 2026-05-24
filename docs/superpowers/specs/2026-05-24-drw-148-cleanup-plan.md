# DRW-148 Cleanup Plan — Remove legacy v1 mermaid import path

## Chosen approach: Option C (modified)

Remove the silent v1 fallback in `importMermaid()` and the `forceV1` option entirely.
Strip the dead `didrawIsGroup: true` field from the two backend places that still write it.

**Reason:** Investigation shows that `didrawIsGroup` is written in `compile.ts` (domain `group` action)
and `migrate-v2.ts` (old envelope migrator) but is **never read** by any runtime code —
layout and context detection use `type === "frame"` and `geo+role=boundary`.
The browser-mode mermaid import already calls `POST /api/schema/create` (v2) first and only
falls back to `importMermaidLegacy()` when the backend is unavailable — a silent fallback that
can produce inconsistent rooms. After DRW-134 shipped the v2 backend endpoint, this fallback
should be removed: if the backend is down, the import should fail with a clear error.

## Changes

### 1. `apps/backend/src/domain/compile.ts`
Remove `didrawIsGroup: true` from the `group` DomainAction frame meta.
The layout and context code never reads this field — `type === "frame"` is the discriminator.

### 2. `apps/backend/src/migrate-v2.ts`
Remove `didrawIsGroup: true` from `groupToFrame()`.
Same reasoning as above.

### 3. `apps/frontend/src/canvas/mermaid-import.ts`
- Remove `forceV1?: boolean` option from `importMermaid()`.
- Remove the `try/catch` fallback — if `createSchemaViaBackend()` fails, rethrow.
- `importMermaidLegacy()` stays (needed by tests that directly unit-test the legacy code path
  as a pure function, and needed for backward-compat reading of existing v1 rooms —
  the function is NOT removed, just no longer called automatically on backend failure).

### 4. Tests
- `apps/backend/tests/migrate-v2.test.ts` — remove `expect(didrawIsGroup).toBe(true)`.
- `apps/backend/tests/layout-pin-discipline.test.ts` — remove `didrawIsGroup` from test shape meta.
- `apps/backend/tests/domain/context.test.ts` — remove `didrawIsGroup` from test shape meta.
- `apps/backend/tests/domain/layout.test.ts` — remove `didrawIsGroup` from test shape meta.
- `apps/backend/tests/domain/layout-drw149-probe.test.ts` — same.
- `apps/frontend/src/canvas/mermaid-import.test.ts` — change `forceV1: true` tests to call
  `importMermaidLegacy` directly (keeping full coverage of the legacy function).
  Add test verifying `importMermaid()` (without forceV1) throws when backend fails.

### 5. `CHANGELOG.md`
Add `[Unreleased]` section with break-change note.

## NOT in scope
- `compile.ts` group action creating `frame` shape — this is the `shemma_group` tool producing
  subgroup frames. We only remove the dead `didrawIsGroup` field from it; the frame shape itself stays.
- `migrate-v2.ts` v2→v3 envelope migration — stays functional, just without the dead field.
- No migration mechanism for existing v1 rooms (AC#3).
