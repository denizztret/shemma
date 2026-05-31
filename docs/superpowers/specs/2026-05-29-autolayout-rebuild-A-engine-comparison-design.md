# Autolayout Rebuild — Sub-project A: Engine Comparison Harness

**Date:** 2026-05-29
**Status:** Design approved (brainstorm), spec reviewed (adversarial grounding+quality pass applied)
**Branch:** `feature/autolayout-rebuild` (от tag `0.28.0` == `main` == `b41c8fb`)

> Все tldraw/mermaid API в этом документе сверены с установленными type-defs (`@tldraw/editor@5.0.0`, `tldraw@5.0.0`, `mermaid@11.12.2`) + `docs/references/tldraw-5x-deep.md`.

---

## 0. Контекст (umbrella)

P1+P2 autolayout (variant search) **отброшен** после ретроспективного аудита: архитектура Pass A/B/C раскладывала каждый subgraph в изоляции и теряла cross-subgraph crossing-minimization. На `sample-2` mermaid.live даёт **~0 пересечений** (и dagre, и elk), наш движок — 11-14. Код заархивирован в `archive/autolayout-p1-p2`; рабочая база откатана на `0.28.0`. Детали — memory `next-session-autolayout-rebuild` + workflow-аудит.

**Новая архитектура (два слоя):**
1. **PLACEMENT (подключаемый)** — где стоят узлы/контейнеры; работает по нарисованному графу. Источник = mermaid-native | ELK | Dagre.
2. **ARROW ROUTING (наш, универсальный)** — поверх любого размещения; L/S/Z/U-локти с одной точкой рычага + минимизация пересечений на реальной геометрии.

Декомпозиция на независимые spec→plan→цикл:
- **A (этот документ)** — селектор движка + сравнение в paste-окне. Цель — *решить*, какой движок брать в основу B.
- **B** — холистический движок размещения по нарисованному графу (re-layout/правки).
- **C** — универсальный single-lever arrow router.

Этот spec покрывает **только A**.

---

## 1. Цель и границы

**Цель.** Дать возможность импортировать один и тот же mermaid-код тремя движками размещения в одну бесконечную доску, рядом, и сравнить качество раскладки (визуально + родной экспорт tldraw в PNG). Выход — обоснованное решение, какой движок брать в основу B.

**В scope:**
- Селектор движка (`Dagre | ELK | Custom`) в paste-модале (`MermaidImportModal`).
- Три рабочих пути импорта.
- Offset-размещение результата в свободное место (без наложения на существующий контент).
- Использование родного экспорта tldraw в PNG (без своих кастомных экспортёров).

**НЕ в scope (это B/C или отдельные задачи):**
- Наш arrow-router (single-lever L/S/Z/U + crossing-min) — кусок C.
- v2-identity (`didrawId`/overlay/AI-протокол) для mermaid-native импортов — делаем в боевом пути после выбора движка.
- Холистический движок размещения по нарисованному графу — кусок B.
- Headless/CLI-импорт: `createMermaidDiagram` требует DOM, поэтому A — **только браузерный paste-путь**. MCP/CLI-импорт остаётся на текущем backend (Custom), без изменений.

**Селектор — поведение.** Engine-state хранится на уровне сессии (last-used): первый раз дефолт = `Custom` (текущее поведение не меняется), при повторном открытии модалки селектор показывает **последний выбранный** движок (НЕ сбрасывается на Custom). Это снимает трение основного сценария «импортировать одну схему тремя движками подряд». `text/error/loading` сбрасываются при закрытии как сейчас; engine — нет.

**Граница Custom-пути.** Backend-создание Custom-схемы (`POST /api/schema/create`) **не меняется**. Добавляется только **frontend post-create reposition**, общий для всех трёх движков (§4); для Custom он может быть перетёрт backend-ownership — known limitation (§9). То есть «без изменений» относится к backend-коду, а не к наблюдаемой позиции результата.

---

## 2. Три движка

| Пункт селектора | Путь | Реализация |
|---|---|---|
| **Dagre** | frontend `createMermaidDiagram(editor, src)` | дефолтный layout mermaid = dagre. Ноль доп-зависимостей. Воспроизводит `dagre-*.png`. |
| **ELK** | frontend `createMermaidDiagram(editor, src, { mermaidConfig: { layout: "elk" } })` | требует dep `@mermaid-js/layout-elk` + **предварительной** регистрации loader'а (§3). Воспроизводит `elk-*.png`. |
| **Custom** | backend — текущий `importMermaid` → `POST /api/schema/create` (v2 schema-frame, shapes через WS) | без изменений; baseline для сравнения. |

**Dagre/ELK — fidelity = throwaway** (решение Q3): **переиспользуем существующий exported `importMermaidLegacy`** (mermaid-import.ts:293 — он `export async function`, в проде сейчас не вызывается, только из ~10 тестов; добавляем второй прод call-site через диспетчер). Через `createMermaidDiagram` он создаёт реальные tldraw-шейпы (контейнеры/узлы/**родные стрелки mermaid**). Без нашей v2-identity, без overlay/AI-протокола, без нашего arrow-router'а. Этого достаточно, чтобы сравнить *качество раскладки* визуально и через PNG.

**Факты из кода** (`@tldraw/mermaid@5.0.0`, mermaid `11.12.2`):
- `createMermaidDiagram(editor, text, options = {})` спредит `options.mermaidConfig` в `mermaid.initialize(...)` → `layout: "elk"` пробрасывается. **Но** одного `mermaidConfig.layout:"elk"` недостаточно — elk-loader должен быть зарегистрирован заранее (§3), иначе mermaid не умеет elk и фоллбэчит на dagre.
- SVG-парсинг (`parseFlowchartLayout(liveSvg)`) layout-агностичен: читает геометрию из уже отрендеренного mermaid'ом SVG, поэтому работает одинаково для dagre и elk.
- `@mermaid-js/layout-elk` **не установлен** (есть только `mermaid@11.12.2` как транзитивная dep) → ELK требует добавления плагина (§9 риск).

---

## 3. Архитектура / data flow

```
MermaidImportModal
   selector state: engine ∈ {dagre, elk, custom}, persist last-used (default custom на 1-й раз)
   └─ onSubmit(source, engine): Promise<{ ok, error? }>
        └─ App.tsx (paste-modal call-site) → importMermaidWithEngine(editor, source, engine, opts)
             ├─ dagre  → importMermaidLegacy(editor, src)                          [frontend, sync shapes]
             ├─ elk    → importMermaidLegacy(editor, src, { layout: "elk" })       [frontend, sync shapes]
             └─ custom → importMermaid(editor, src)                                [backend v2, shapes via WS]
        └─ после создания: reposition результата в свободное место (см. §4)
```

`importMermaidWithEngine` — новый тонкий диспетчер в `mermaid-import.ts`. Возвращает расширенный `MermaidImportResult` (см. §6, поля `engineUsed`/`engineFallback`).

**ELK loader registration (важно — разводим два модуля):**
- `loadMermaid()` (mermaid-import.ts:183) возвращает модуль **`@tldraw/mermaid`** (для `createMermaidDiagram`). Он НЕ реэкспортирует `registerLayoutLoaders`.
- Регистрация loader'а делается на **пакете `mermaid`** напрямую: `import mermaid from "mermaid"; mermaid.registerLayoutLoaders(elkLayouts)` (метод подтверждён в `mermaid@11.12.2/dist/mermaid.d.ts:173`). Это **тот же физический инстанс**, что использует `createMermaidDiagram` внутри (`createMermaidDiagram.ts:3` импортирует `import mermaid from "mermaid"`; bun дедуплицирует единственную копию `mermaid@11.12.2` — проверено).
- Регистрация **идемпотентна** (module-level guard-флаг), выполняется один раз до первого ELK-импорта.
- Если регистрация бросает (loader несовместим/не нашёлся) — ловим, выставляем `engineFallback=true`, ELK-импорт идёт как dagre (§9). Детекция «mermaid проигнорировал layout:elk» программно ненадёжна → маркер ставится на уровне catch вокруг `registerLayoutLoaders`, а визуальное совпадение dagre≈elk проверяет контроллер (§8).

---

## 4. Offset-размещение (одна доска, без наложения)

Цель — три импорта ложатся рядом на бесконечной доске автоматически.

**Чистая функция** (для детерминированного теста, §7):
```ts
const IMPORT_GAP = 200;
// pageBounds: editor.getCurrentPageBounds() → Box | undefined
// viewportBounds: editor.getViewportPageBounds() → Box
function computeImportOriginX(pageBounds: Box | undefined, viewportBounds: Box, gap = IMPORT_GAP): number {
  return pageBounds ? pageBounds.maxX + gap : viewportBounds.minX;
}
```
- `getCurrentPageBounds()` возвращает `undefined` на пустой странице — это и есть «free space на пустой доске»: fallback на `viewportBounds.minX` (новый контент появляется в видимой области). `Box.maxX` существует (getter, `@tldraw/editor@5.0.0` index.d.ts:586).

**Применение:**
- **Dagre/ELK:** после `createMermaidDiagram` собрать id новых шейпов (diff `before/after` — уже делается в `importMermaidLegacy`), вычислить их bbox, сдвинуть корневые новые шейпы так, чтобы их `minX` совпал с `computeImportOriginX(...)` (`editor.updateShapes` по корням; дети двигаются вместе с родителем).
- **Custom:** frame создаётся backend'ом и приходит через WS асинхронно — `importMermaid` возвращает `{frameId}` **до** появления записи в `editor.store`. Reposition — **best-effort**: подписка `editor.store.listen` / `react()` ждёт `editor.getShape(frameId)` с **bounded timeout (2000 ms)**; как только frame есть — `editor.updateShape({ id: frameId, x, y })` к origin; если за таймаут не появился — reposition пропускается (логируется). Риск гонки с WS-debounce — см. memory `drw-166-ws-debounce-race`.

**YAGNI:** правило узкое — «правее существующего контента». Полноценный bbox-aware packing (DRW-085) — вне scope A.

---

## 5. PNG-экспорт

Используем **родной** tldraw 5.0.0 API (сверено по type-defs; `exportToBlob` из tldraw 2.x **не существует** в 5.x — не использовать):
- Blob (программно): `const { blob } = await editor.toImage(ids, { format: "png" })` (`@tldraw/editor@5.0.0` index.d.ts:4177).
- Download (UI, опционально): `await exportAs(editor, ids, { format: "png" })` (top-level из `tldraw`, index.d.ts:1996; формат — внутри opts-объекта, не третьим строковым аргументом).

Для сравнения контроллер (main agent) через chrome-devtools MCP выделяет каждый результат и снимает PNG — на реальной доске, без synthetic-моков (memory `feedback-ws-subscriber-via-chrome-mcp`, `feedback-no-subagent-screenshot-trust`). Кнопка «Export selection PNG» в UI — **не в scope A** (встроенного механизма tldraw достаточно).

---

## 6. Файлы

- `apps/frontend/src/mermaid/MermaidImportModal.tsx` — добавить `<select>` engine; расширить проп `onSubmit` до `(source, engine)`; engine-state не сбрасывать при закрытии (хранить last-used).
- `apps/frontend/src/canvas/mermaid-import.ts`:
  - `importMermaidWithEngine(editor, source, engine, opts)` — диспетчер.
  - `importMermaidLegacy(editor, source, opts?: { layout?: "elk" })` — добавить проброс `mermaidConfig.layout`.
  - идемпотентная регистрация elk-loader через прямой `import mermaid from "mermaid"` (§3).
  - offset-логика: `computeImportOriginX` (чистая) + применение к dagre/elk (sync) и custom (WS-wait, best-effort).
  - расширить тип `MermaidImportResult` (mermaid-import.ts:~226): `engineUsed?: "dagre" | "elk" | "custom"`, `engineFallback?: boolean`.
- `apps/frontend/src/App.tsx` — проброс `engine` из `MermaidImportModal.onSubmit` в `importMermaidWithEngine` в **paste-modal call-site (~:689)**. Call-sites `importMermaid` на **App.tsx:389 (AI/backend WS import)** и **:592 (dev-helper)** — **НЕ трогаем** (селектор движка только в paste-модалке).
- `apps/frontend/package.json` — dep `@mermaid-js/layout-elk` (`^0.2.x`, peer `mermaid ^11.0.2` → покрывает 11.12.2; установлено `0.2.1`. NB: published 1.x не существует). Плюс `mermaid@11.12.2` прямой зависимостью (одна копия с `@tldraw/mermaid` → shared instance + tsc-резолв `import("mermaid")`).

Backend и `@shemma/*` пакеты **не трогаем**.

---

## 7. Тестирование

- `apps/frontend/src/canvas/mermaid-import.test.ts` (уже мокает `createMermaidDiagram` через `mock.module("@tldraw/mermaid", ...)`):
  - `importMermaidWithEngine(engine="dagre")` зовёт `createMermaidDiagram` без `mermaidConfig.layout`.
  - `engine="elk"` зовёт с `mermaidConfig.layout === "elk"`.
  - `engine="custom"` идёт через backend-путь (мок `createSchemaViaBackend`/fetch), `createMermaidDiagram` НЕ зовётся.
  - результат несёт `engineUsed`; при имитации ошибки регистрации loader — `engineFallback === true` и путь = dagre.
  - createMermaidDiagram бросает `MermaidDiagramError` (невалидный/unsupported диаграмм-тип) → `importMermaidWithEngine` возвращает `{ok:false, error}` (модалка остаётся открытой).
- ELK-loader idempotency: тест мокает **пакет `mermaid`** (НЕ `@tldraw/mermaid`) и проверяет, что `registerLayoutLoaders` вызван ровно один раз при повторных ELK-импортах.
- `computeImportOriginX`: чистая функция, детерминированные кейсы — есть контент (`pageBounds.maxX + GAP`), пустая страница (`pageBounds=undefined` → `viewportBounds.minX`).
- `MermaidImportModal`: `onSubmit` вызывается с выбранным engine; engine-state не сбрасывается при reopen.
- Прогон: `bun test --cwd apps/frontend src` зелёный; biome/tsc по фронту зелёные. Backend-suite не трогаем.

## 8. Приёмка / выход

**Функциональные AC:**
- В paste-модале выбирается движок; импорт ложится в свободное место правее существующего контента; PNG-экспорт выделения (`editor.toImage`) отдаёт blob.
- Каждый из трёх движков продуцирует **валидную** раскладку. (NB: dagre и elk могут совпасть, если elk-loader не активен — это ожидаемый деградационный путь, фиксируется явно через `engineFallback`, не баг.)

**Решающая метрика (research-выход):**
- Контроллер прогоняет `sample-2` (+1-2 реальные схемы) каждым движком в одну доску, снимает PNG, сравнивает с эталонами `~/Projects/draft-n-old/mermaid-mr-345/`.
- Рубрика выбора: **визуальный подсчёт пересечений** на `sample-2` (считает контроллер) + читаемость + компактность (aspect ratio). **Основа B = движок с наименьшим числом пересечений на `sample-2` при сопоставимой компактности.**
- Решение + числа фиксируются в `docs/references/` и memory. Закрывает research-задачу **DRW-151**.

## 9. Риски

- **ELK loader / инстанс mermaid (главный).** `createMermaidDiagram` использует `import mermaid from "mermaid"`. Регистрация elk-loader делается на **этом же пакете** напрямую (§3). Bun дедуплицирует `mermaid@11.12.2` в одну физическую копию → регистрация *ожидаемо* подействует, но проверяется при реализации (ELK-результат визуально ≠ dagre). Фоллбэк: ошибка регистрации → `engineFallback=true`, ELK идёт как dagre (не молча).
- **Reposition Custom-frame.** Сдвиг v2 schema-frame после backend-создания может конфликтовать с backend-ownership/echo-guard и WS-debounce (`drw-166-ws-debounce-race`). Для throwaway-A допустимо; best-effort с таймаутом, при неудаче — пропуск + лог. Known limitation, не блокер решения.
- **Версия `@mermaid-js/layout-elk`.** Должна быть совместима с mermaid `11.12.2`. Зафиксировать точную версию при добавлении dep; проверить, что peer-range покрывает 11.12.2.

## 10. Что дальше (вне A)

- **B** — холистический движок размещения по нарисованному графу: native ELK done right (`INCLUDE_CHILDREN` + `separateConnectedComponents` + `aspectRatio`, которые в P2 не выставлялись) ИЛИ Dagre — по итогам A. Детерминизм (`randomSeed`/стабильный input) — требование.
- **C** — universal single-lever arrow router (L/S/Z/U, одна точка рычага) + crossing-min на реальной геометрии. Живые баги: DRW-175/176/177.
