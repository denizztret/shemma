import type { FC } from "react";
import type { LayoutParams } from "@shemma/domain";

type Field = {
  key: keyof LayoutParams;
  label: string;
  hint?: string;
};

type Group = {
  title: string;
  fields: ReadonlyArray<Field>;
};

const GROUPS: ReadonlyArray<Group> = [
  {
    title: "Узлы",
    fields: [
      { key: "nodeMinWidth", label: "Мин. ширина", hint: "Узел не сжимается уже этого значения, даже если текст короче" },
      { key: "nodeMinHeight", label: "Мин. высота", hint: "Узел не сжимается ниже этого значения" },
      { key: "nodePadding", label: "Внутренний отступ", hint: "Поля между текстом узла и его рамкой" },
    ],
  },
  {
    title: "Контейнеры",
    fields: [
      { key: "containerPadding", label: "Отступы внутри", hint: "Поля между рамкой контейнера и его дочерними узлами" },
      { key: "containerLabelHeight", label: "Высота заголовка", hint: "Высота шапки контейнера, в которой выводится его имя" },
    ],
  },
  {
    title: "Связи",
    fields: [
      { key: "edgeSpacing", label: "Между связями", hint: "Минимальный зазор между двумя параллельными стрелками" },
      { key: "edgeNodeSpacing", label: "Узел ↔ связь", hint: "Минимальный зазор между узлом и проходящей рядом стрелкой" },
    ],
  },
  {
    title: "Подписи на связях",
    fields: [
      { key: "edgeLabelMaxWidth", label: "Макс. ширина", hint: "После этого ширина подписи начинает переноситься на новые строки" },
      { key: "edgeLabelMaxLines", label: "Макс. строк", hint: "Сколько строк может занимать подпись" },
      { key: "edgeLabelMargin", label: "Отступ от стрелки", hint: "Расстояние между текстом подписи и линией стрелки" },
      { key: "edgeLabelFontSize", label: "Размер шрифта", hint: "Размер шрифта подписи (px)" },
    ],
  },
];

export type BoardPanelAdvancedProps = {
  effective: LayoutParams;
  onFieldChange: (field: keyof LayoutParams, value: number) => void;
  onReset: () => void;
  onBack: () => void;
};

export const BoardPanelAdvanced: FC<BoardPanelAdvancedProps> = ({ effective, onFieldChange, onReset, onBack }) => (
  <div className="settings-popover__panel settings-popover__panel--advanced" role="dialog" aria-label="Расширенные параметры компоновки">
    <div className="settings-popover__header">
      <button type="button" onClick={onBack} className="settings-link">← Назад</button>
      <button type="button" onClick={onReset} className="settings-link">Сбросить</button>
    </div>
    <div className="settings-popover__form">
      {GROUPS.map((group) => (
        <div key={group.title} className="settings-popover__group">
          <div className="settings-popover__group-label">{group.title}</div>
          {group.fields.map((field) => (
            <label key={field.key} className="settings-field" title={field.hint}>
              <span className="settings-field__label">{field.label}</span>
              <input
                type="number"
                min={0}
                step={1}
                value={effective[field.key] as number}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= 0) onFieldChange(field.key, v);
                }}
                className="settings-field__input"
              />
            </label>
          ))}
        </div>
      ))}
    </div>
  </div>
);
