# ADR-0001: Mermaid import — backend vs frontend

**Date:** 2026-05-15
**Status:** Decided

## Context

Spec §4 предусматривал backend-side mermaid-import через `@tldraw/mermaid`. Phase 0.1 spike (Task 4) проверяет, работает ли пакет в Bun с jsdom-полифиллом.

## Spike result

### Загрузка модуля

`@tldraw/mermaid@5.0.0` успешно устанавливается в backend (без peer-dep ошибок, только предупреждения о React).
Модуль загружается за 382.6 мс. Экспортируемые ключи:

```
[ "MERMAID_MINDMAP_NODE_TYPE", "MermaidDiagramError", "createMermaidDiagram",
  "defaultCreateMermaidNodeFromBlueprint", "defaultMermaidNodeRenderSpec", "renderBlueprint",
  "resolveMermaidNodeRender" ]
```

### Выполнение createMermaidDiagram

Функция `createMermaidDiagram` существует в модуле, но реальная сигнатура — `createMermaidDiagram(editor: Editor, text: string, options?)`, где `Editor` — это экземпляр tldraw Editor (полноценный React-компонент с DOM-монтированием).

Все попытки вызова завершились одинаково:

```
FAIL: mermaid diagram error: not a mermaid diagram
```

Трассировка стека:
```
MermaidDiagramError: mermaid diagram error: not a mermaid diagram
    at createMermaidDiagram (node_modules/@tldraw/mermaid/dist-esm/createMermaidDiagram.mjs:39:15)
    at processTicksAndRejections (native:7:39)
```

Анализ исходника `createMermaidDiagram.mjs:39`: функция вызывает `mermaid.parse(text, { suppressErrors: true })` — если `mermaid` не может инициализироваться без полноценного DOM (в т.ч. CSS-переменные, SVG-рендеринг, `getBoundingClientRect`), `parse()` возвращает `undefined`, и функция бросает `MermaidDiagramError("not a mermaid diagram", "parse")`. jsdom не предоставляет SVG layout engine, что и является причиной отказа.

### mmdc CLI fallback

`bunx -y @mermaid-js/mermaid-cli` (v11.15.0) доступен и работает корректно:

```bash
printf 'graph LR\na-->b' | mmdc -i /tmp/test.mmd -o /tmp/test-out.svg
# → Generating single mermaid chart
# → /tmp/test-out.svg: 10724 байт, корректный SVG
```

`mmdc` использует headless Chromium (puppeteer) — полноценный браузер. Генерирует SVG, но не даёт tldraw shapes напрямую.

## Decision

**B) Frontend implementation** — frontend конвертирует Mermaid → tldraw shapes с помощью `@tldraw/mermaid` (уже доступен как зависимость tldraw), после чего отправляет `POST /api/patch` на backend.

`@tldraw/mermaid` — это **browser-only / React-only** пакет. `createMermaidDiagram` требует экземпляра tldraw `Editor` (React-компонент), использует SVG-рендеринг mermaid через полноценный DOM с layout engine. jsdom не предоставляет необходимых API (`getBoundingClientRect`, SVG layout) — `mermaid.parse()` возвращает `undefined` в окружении без CSS/SVG движка, делая backend-реализацию невозможной без полноценного браузера. Время загрузки в 382 мс и блокирующий характер рендеринга (puppeteer) дополнительно исключают вариант A даже гипотетически. Вариант C (hybrid с mmdc для валидации) не нужен: mermaid-синтаксис безопасен для парсинга на frontend без серверной валидации.

## Consequences for Task 22

Decision: **B**.

- Task 22 добавляет `@tldraw/mermaid` в `apps/frontend/dependencies` (если уже не подтянут транзитивно через `tldraw`).
- Backend **не получает** `POST /api/import/mermaid` — endpoint не нужен. Frontend конвертирует Mermaid → `PatchOp[]` локально через `createMermaidDiagram(editor, text)` и отправляет `POST /api/patch`.
- `@tldraw/mermaid` и `jsdom` **удаляются** из `apps/backend/dependencies` и `devDependencies` (`bun remove @tldraw/mermaid jsdom @types/jsdom`).
- Директория `apps/backend/spike/` удаляется в Task 22 (сейчас сохраняется для документирования оценки).
- ADR-0001 (этот файл) остаётся в `docs/decisions/`.
