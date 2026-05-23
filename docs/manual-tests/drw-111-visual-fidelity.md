# DRW-111 Manual E2E Smoke Test — Visual Fidelity v2

## Setup

1. Pre-built binary 0.24.0 или `bun run dev` (Vite + daemon).
2. Тестовая доска Miro (чистая или отдельная от рабочих).
3. Токен: `~/.config/shemma/config.json` с полем `miro.token`.

## Canvas для рисования

Нарисовать на доске шемма:

- 1 внешний boundary frame "Backend services" (цвет: blue, dash: dashed)
- 1 внутренний boundary frame "api layer" внутри внешнего
- 3 shape-объекта:
  - rectangle, red, fill: solid, size: m
  - ellipse, blue, fill: semi, size: l
  - diamond, green, fill: none, size: xl
- 2 sticky note (yellow + violet, size: m)
- 1 standalone text (цвет: red, font: mono, size: m)
- 2 стрелки:
  - solid (цвет: black, arrowheadEnd: triangle)
  - dashed (цвет: red, arrowheadEnd: diamond)

## Шаги

1. Cmd+Shift+E → ExportMiroModal.
2. Вставить id тестовой доски.
3. Выполнить экспорт.

## Чеклист верификации

- [ ] Два frame'а рендерятся как белые прямоугольники с названием сверху (НЕ Miro frame widget — без titlebar с серым фоном).
- [ ] Перетащить внешний frame в Miro → весь контент движется одним блоком (flat group, Phase 0 ограничение).
- [ ] Перетащить внутренний frame → поддерево движется; внешний прямоугольник + S1 остаются на месте.
- [ ] Цвета shape-объектов соответствуют палитре tldraw:
  - red rectangle → `#e03131` border + fill
  - blue ellipse → `#4465e9` border, 50% opacity fill
  - green diamond → `#099268` border, 0% fill (none)
- [ ] Sticky notes: yellow + ближайший violet (через nearestStickyColor).
- [ ] Text widget: красный цвет, моноширинный шрифт, ~14px.
- [ ] Стрелки: black + filled triangle end; red + filled diamond end.

## Известные ограничения (покрыты в release notes)

- Arrowhead'ы `square` / `bar` / `pipe` экспортируются без head (Miro не поддерживает прямоугольные caps).
- `inverted` arrowhead деградирует до forward arrow.
- `pattern` fill визуально идентичен `semi` (Miro не поддерживает диагональную заливку).
- Повторный экспорт создаёт дубли элементов (append-only модель).
- Nested groups уплощены (нельзя независимо таскать outer frame — Phase 0 finding).

## Итог

- [ ] PASS — отмечено пользователем после релиза.
