// apps/frontend/src/shapes/schema-container/title-position.ts
//
// Canonical definition + pure helpers for SchemaContainer titlePosition enum.
//
// История enum'а:
// - до DRW-186: `"inside" | "outside"`.
// - DRW-186 phase 1: `"outside" | "inside-center" | "inside-left"`.
// - DRW-186 phase 2 (this file): расщепляем `"outside"` на два визуально разных
//   варианта `"outside-frame"` (native Frame parity — neutral bg + dark text,
//   top-left aligned) и `"outside-banner"` (coloured banner, monolith corners).
//   Phase-1 `"outside"` мигрируется в `"outside-banner"` (визуально совпадает
//   с тем, что DRW-186 уже шипал).
//
// Миграции собраны в SchemaContainerMigrations.ts (sequence steps /1 + /2).
// normalizeTitlePosition — runtime guard для board-policy resolver'а, имеет
// идентичную семантику миграции (legacy → канон, unknown → default).

export type SchemaContainerTitlePosition =
  | "outside-frame"
  | "outside-banner"
  | "inside-center"
  | "inside-left";

const VALID = new Set<SchemaContainerTitlePosition>([
  "outside-frame",
  "outside-banner",
  "inside-center",
  "inside-left",
]);

const DEFAULT_TITLE_POSITION: SchemaContainerTitlePosition = "inside-center";

/**
 * Coerces legacy / unknown values to the current enum.
 *
 * - Legacy `"inside"` → `"inside-center"` (canonical migration, phase 1).
 * - Legacy `"outside"` → `"outside-banner"` (phase 2 — old visual = coloured banner).
 * - Valid new enum values pass through.
 * - Anything else (unknown strings, undefined, null, non-string) → default.
 */
export function migrateTitlePosition(
  value: unknown,
): SchemaContainerTitlePosition {
  if (value === "inside") return "inside-center";
  if (value === "outside") return "outside-banner";
  if (typeof value === "string" && VALID.has(value as SchemaContainerTitlePosition)) {
    return value as SchemaContainerTitlePosition;
  }
  return DEFAULT_TITLE_POSITION;
}

/**
 * True для любого варианта, где label рисуется ВЫШЕ body (negative-Y bar).
 * Используется в getGeometry / render-time switch — там, где важно различие
 * outside/inside по геометрии, но не различие между outside-frame и
 * outside-banner.
 */
export function isOutsideVariant(
  value: SchemaContainerTitlePosition,
): boolean {
  return value === "outside-frame" || value === "outside-banner";
}

/**
 * Alias for runtime normalization (e.g. of board-policy meta or persisted hints).
 * Identical semantics to `migrateTitlePosition` — exposed under a separate name
 * to make read-sites self-documenting (migration vs. runtime guard).
 */
export function normalizeTitlePosition(
  value: unknown,
): SchemaContainerTitlePosition {
  return migrateTitlePosition(value);
}
