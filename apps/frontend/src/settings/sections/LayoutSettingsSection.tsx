// apps/frontend/src/settings/sections/LayoutSettingsSection.tsx
import type { LayoutAlgorithm } from "@shemma/domain";
import type { FC } from "react";

// Spec 7.3: null variants = mixed / indeterminate state for multi-selection.
export type LayoutSettingsValue = {
  preset: "compact" | "normal" | "loose" | null;
  // Autolayout rebuild — placement engine (ELK algorithm) per frame/container.
  // Optional: only the per-frame/container panel (SelectionPanel) drives it; the
  // board-level panel omits it (runElkLayout reads engine from frame/container
  // meta, not room-level board params).
  engine?: LayoutAlgorithm | null;
};

// Engine selector (autolayout rebuild). Short labels; tooltips carry the detail.
const ENGINE_ORDER: readonly LayoutAlgorithm[] = [
  "layered",
  "mrtree",
  "stress",
  "force",
];
export const ENGINE_LABELS: Record<LayoutAlgorithm, string> = {
  layered: "Слои",
  mrtree: "Дерево",
  stress: "Стресс",
  force: "Силы",
};
const ENGINE_HINTS: Record<LayoutAlgorithm, string> = {
  layered:
    "Слои (layered) — стандарт для ветвящихся и плотных графов; узлы выстраиваются по слоям вдоль направления потока.",
  mrtree:
    "Дерево (mrtree) — центрированная «ёлочка»: родитель по центру детей, братья на одном ярусе. Лучше всего для иерархий.",
  stress:
    "Стресс (stress) — органичная компактная раскладка с малым числом пересечений; без явного деления на слои.",
  force:
    "Силы (force) — силовая «пружинная» раскладка для сильно связных графов без выраженной иерархии.",
};

// UI labels (Compact / Normal / Roomy) intentionally differ from the @shemma/domain
// Spacing enum ("compact" | "normal" | "loose"). "Roomy" — пользовательская строка для "loose".
export const PRESET_LABELS: Record<"compact" | "normal" | "loose", string> = {
  compact: "Compact",
  normal: "Normal",
  loose: "Roomy",
};

export const PRESET_HINTS: Record<"compact" | "normal" | "loose", string> = {
  compact: "Плотная компоновка — больше элементов на экране",
  normal: "Стандартный шаг сетки",
  loose: "Просторно — легче читать диаграмму",
};

export type LayoutSettingsSectionProps = {
  current: LayoutSettingsValue;
  onPreset: (p: "compact" | "normal" | "loose") => void;
  // Optional — only the per-frame/container panel renders the engine selector.
  onEngine?: (e: LayoutAlgorithm) => void;
  onAdvanced: () => void;
  onReset: () => void;
  showReset: boolean;
  showAdvanced?: boolean; // default true (BoardPanel); SelectionPanel passes false until per-frame Advanced UX готов
};

export const LayoutSettingsSection: FC<LayoutSettingsSectionProps> = ({
  current,
  onPreset,
  onEngine,
  onAdvanced,
  onReset,
  showReset,
  showAdvanced = true,
}) => (
  <div className="settings-section settings-section--layout-settings">
    {onEngine && (
      <>
        <div className="settings-section__label">Движок раскладки</div>
        <div className="settings-section__row settings-section__row--layout-engine">
          {ENGINE_ORDER.map((e) => (
            <button
              key={e}
              type="button"
              data-engine={e}
              title={ENGINE_HINTS[e]}
              onClick={() => onEngine(e)}
              className={`settings-btn${current.engine === e ? " settings-btn--on" : ""}`}
            >
              {ENGINE_LABELS[e]}
            </button>
          ))}
        </div>
      </>
    )}
    <div className="settings-section__label">Компоновка</div>
    <div className="settings-section__row">
      {(["compact", "normal", "loose"] as const).map((p) => (
        <button
          key={p}
          type="button"
          data-preset={p}
          title={PRESET_HINTS[p]}
          onClick={() => onPreset(p)}
          className={`settings-btn${current.preset === p ? " settings-btn--on" : ""}`}
        >
          {PRESET_LABELS[p]}
        </button>
      ))}
    </div>
    {showAdvanced && (
      <button
        type="button"
        data-role="advanced"
        onClick={onAdvanced}
        className="settings-link"
      >
        Дополнительно ›
      </button>
    )}
    {showReset && (
      <button
        type="button"
        data-role="reset"
        onClick={onReset}
        className="settings-link settings-link--muted"
      >
        Сброс к defaults
      </button>
    )}
  </div>
);
