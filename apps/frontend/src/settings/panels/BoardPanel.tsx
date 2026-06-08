import type { FC } from "react";
import { DirectionSection, type DirectionValue } from "../sections/DirectionSection";
import { StylesSection, type StyleSectionValue } from "../sections/StylesSection";
import { ArrowKindSection } from "../sections/ArrowKindSection";
import { ContainerTitlePositionSection } from "../sections/ContainerTitlePositionSection";
import type {
  ArrowKind, LayoutParams,
  ResolvedStyleDefaults, StyleDash, StyleFont, StyleSize,
} from "@shemma/domain";
import type { SchemaContainerTitlePosition } from "../../shapes/schema-container/title-position";

const DIRECTION_HINTS: Record<DirectionValue, string> = {
  TB: "Сверху вниз",
  LR: "Слева направо",
  BT: "Снизу вверх",
  RL: "Справа налево",
  custom: "Пользовательское направление контейнеров",
};

export type BoardPanelProps = {
  effective: LayoutParams;
  onDirectionChange: (d: DirectionValue) => void;
  onOpenAdvanced: () => void;
  onOpenShortcuts: () => void;
  styleEffective: ResolvedStyleDefaults;
  onStyleDash: (v: StyleDash) => void;
  onStyleFont: (v: StyleFont) => void;
  onStyleSize: (v: StyleSize) => void;
  /** DRW-207: board default типа стрелок; null = unset (статус-кво). */
  styleArrowKind: ArrowKind | null;
  /** Tri-state toggle: caller снимает default при клике по активной кнопке. */
  onStyleArrowKind: (v: ArrowKind) => void;
  containerTitlePosition: SchemaContainerTitlePosition;
  onContainerTitlePositionChange: (next: SchemaContainerTitlePosition) => void;
};

export const BoardPanel: FC<BoardPanelProps> = ({
  effective,
  onDirectionChange,
  onOpenAdvanced,
  onOpenShortcuts,
  styleEffective,
  onStyleDash,
  onStyleFont,
  onStyleSize,
  styleArrowKind,
  onStyleArrowKind,
  containerTitlePosition,
  onContainerTitlePositionChange,
}) => {
  const styleValue: StyleSectionValue = {
    dash: styleEffective.dash,
    font: styleEffective.font,
    size: styleEffective.size,
  };

  return (
    <div className="settings-popover__panel" role="dialog" aria-label="Настройки доски">
      <h2
        className="settings-popover__title settings-tooltip"
        data-tooltip="Применяется к новому содержимому, импорту и AI-агенту. На уже размещённые на доске схемы не влияет."
      >
        По умолчанию
      </h2>
      <DirectionSection
        current={effective.defaultDirection}
        onChange={onDirectionChange}
        hints={DIRECTION_HINTS}
      />
      <button
        type="button"
        data-role="advanced"
        onClick={onOpenAdvanced}
        className="settings-link"
      >
        Дополнительно ›
      </button>
      <StylesSection
        current={styleValue}
        onDash={onStyleDash}
        onFont={onStyleFont}
        onSize={onStyleSize}
      />
      <ArrowKindSection current={styleArrowKind} onChange={onStyleArrowKind} />
      <ContainerTitlePositionSection
        current={containerTitlePosition}
        onChange={onContainerTitlePositionChange}
      />
      <button
        type="button"
        data-role="shortcuts"
        onClick={onOpenShortcuts}
        className="settings-link"
      >
        Горячие клавиши ›
      </button>
    </div>
  );
};
