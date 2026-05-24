# DRW-149 Autolayout в schema-frame — Manual E2E checklist

**Cover:** AC-1..AC-12 из spec v0.2 (`docs/superpowers/specs/2026-05-24-drw-149-autolayout-in-frame-design.md`).

## Preconditions

- Release daemon запущен: `shemma daemon start --profile release` (port 8787).
- Frontend production-build загружен либо dev-сервер запущен (`bun --cwd apps/frontend run dev` → port 5173).
- Тестовая комната создана и заполнена fixture-данными (см. Setup).

## Setup

Создать room через CLI и наполнить mermaid-схемой через MCP `shemma_import_mermaid`:

```bash
shemma open --room drw-149-test --space di-draw
```

Импортировать через MCP `shemma_import_mermaid` (mode=browser → создаёт v2 schema-frame с shape-container'ами):

```
flowchart TB
  subgraph INPUT [Вход]
    SE[SourceEvent]
  end
  subgraph ORCH [Оркестрация]
    ER[EventRouter]
    EP[EventPolicyProtocol]
  end
  subgraph CONSUMERS [Потребители]
    IC[InternalConsumer]
    PB[PublicBoundary]
  end
  SE --> ER
  ER --> EP
  EP --> IC
  EP --> PB
```

Открыть в браузере: `http://localhost:5173/?space=di-draw&room=drw-149-test` (dev) или `http://localhost:8787/?room=drw-149-test&space=di-draw` (release).

## Test 1 — AC-1: Cmd+Shift+L на schema-frame

- [ ] Кликнуть на границу schema-frame чтобы выделить ТОЛЬКО его (не детей).
- [ ] Cmd+Shift+L.
- [ ] **Ожидание:** все 3 subgraph'а (INPUT, ORCH, CONSUMERS) и их services выровнены TB; schema-frame resize'нут под bbox + padding; visual overlap отсутствует.

## Test 2 — AC-2: Cmd+Shift+L на children schema-frame (без самого frame)

- [ ] Drag-select всё содержимое schema-frame (без захвата самой рамки).
- [ ] Cmd+Shift+L.
- [ ] **Ожидание:** результат визуально совпадает с Test 1 (anchor detection работает).

## Test 3 — AC-3: Cmd+Shift+L на schema-frame + external (G3)

- [ ] Создать дополнительный shape (rect или sticky) **вне** schema-frame.
- [ ] Cmd+click схема-frame + external shape.
- [ ] Cmd+Shift+L.
- [ ] **Ожидание:** ни один child schema-frame не оказался за пределами рамки; external shape и schema-frame стоят как peers в общем layout; внутри schema-frame сохранился porядок subgraph'ов.

## Test 4 — AC-4: Single shape

- [ ] Кликнуть на один service (например EP).
- [ ] Cmd+Shift+L.
- [ ] **Ожидание:** ничего не двигается, в console нет ошибок, HTTP 200 ok count=0.

## Test 5 — AC-5: Empty selection

- [ ] Кликнуть на пустое место (deselect all).
- [ ] Cmd+Shift+L.
- [ ] **Ожидание:** ничего не происходит, без error.

## Test 6 — AC-6: Nested shape-containers

- [ ] В schema-frame должно быть ≥2 уровня вложенности (если mermaid выше не даёт — создать nested subgraph руками).
- [ ] Выделить schema-frame, Cmd+Shift+L.
- [ ] **Ожидание:** bottom-up recursion отработала — самые внутренние контейнеры выровнены первыми, затем родители resize'нулись.

## Test 7 — AC-7: External arrow filtering

- [ ] Из service внутри schema-frame нарисовать arrow к external shape (созданный в Test 3).
- [ ] Выделить schema-frame, Cmd+Shift+L.
- [ ] **Ожидание:** inner service остался внутри schema-frame (не "ушёл" за ребёнком стрелки).

## Test 8 — AC-8: Pinned shape

- [ ] Через MCP `shemma_define` обновить shape с `meta.pinned = true` (или вручную через chrome-devtools).
- [ ] Выделить schema-frame, Cmd+Shift+L.
- [ ] **Ожидание:** pinned service не сдвинулся, остальные перерасставились.

## Test 9 — AC-12: Undo (КРИТИЧНО — G7)

- [ ] Запомнить визуальное состояние или сделать snapshot через `shemma_canvas_view`.
- [ ] Cmd+Shift+L (любой из Test 1-3).
- [ ] **Cmd+Z (undo)** — одно нажатие.
- [ ] **Ожидание:** ВСЕ shape-позиции и envelope-размеры вернулись в pre-layout состояние; одной операцией undo.
- [ ] **Cmd+Shift+Z (redo)** — одно нажатие.
- [ ] **Ожидание:** post-layout восстановлен.

## Test 10 — AC-9: Existing functionality regression

- [ ] Cmd+Shift+L на selection из 5+ обычных shapes (не frame) — должно работать как до DRW-149 (стандартный tidy layout).
- [ ] Cmd+Shift+L на 2+ frame'ах вне schema-frame — должно расположить frames как peers.

## Cleanup

```bash
shemma delete --room drw-149-test --space di-draw
```

## Известные ограничения

- **Multi-client undo:** Cmd+Z на клиенте A не откатывает state клиента B (только локальная history). Для production multi-client — отдельный ticket.
- **`meta.styleOwnedBy: "user"`** — не покрыто Test 1-9; ожидается что layout не трогает style fields в принципе.
