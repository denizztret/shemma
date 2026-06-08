// apps/frontend/src/settings/sections/DensitySection.tsx
//
// DRW-239: relative density control. A gesture scales the addressed shapes'
// distances about an anchor (right = spread, left = compress) WITHOUT re-running
// the layout — structure/direction are preserved and a min-gap stops overlaps.
// There is no "default" to snap back to; ⌘Z undoes a gesture. `start` captures
// the pre-drag snapshot, `change(k)` applies the snapshot×k live, `end` commits.
//
// Lives in its own section (not LayoutSettingsSection) because it applies to ANY
// respreadable selection — a container, a frame, or just ≥2 loose nodes — whereas
// the direction/engine controls only make sense for containers.

import type { FC } from "react";

export type DensityHandlers = {
  start: () => void;
  change: (k: number) => void;
  end: () => void;
};

export const DENSITY_MIN = 0.5;
export const DENSITY_MAX = 2;
export const DENSITY_STEP = 0.05;

export const DensitySection: FC<{ onDensity: DensityHandlers }> = ({
  onDensity,
}) => (
  <div className="settings-section settings-section--density">
    <div className="settings-section__label">Плотность</div>
    <div className="settings-section__row settings-section__row--density">
      <span className="settings-density__icon" aria-hidden="true">
        −
      </span>
      <input
        type="range"
        data-role="density"
        min={DENSITY_MIN}
        max={DENSITY_MAX}
        step={DENSITY_STEP}
        defaultValue={1}
        className="settings-density__slider"
        title="Раздвинуть (вправо) или сблизить (влево) выделенное. Применяется сразу; ⌘Z отменяет."
        onPointerDown={() => onDensity.start()}
        onInput={(e) => onDensity.change(Number(e.currentTarget.value))}
        onPointerUp={(e) => {
          onDensity.end();
          e.currentTarget.value = "1";
        }}
        onPointerCancel={(e) => {
          onDensity.end();
          e.currentTarget.value = "1";
        }}
      />
      <span className="settings-density__icon" aria-hidden="true">
        +
      </span>
    </div>
  </div>
);
