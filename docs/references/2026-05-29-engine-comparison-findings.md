# Engine Comparison Findings — Mermaid Import (sub-project A)

**Date:** 2026-05-29
**Closes:** DRW-151 (native @tldraw/mermaid vs backend)
**Context:** Autolayout rebuild, sub-project A (engine comparison harness). Spec/plan: `docs/superpowers/{specs,plans}/2026-05-29-autolayout-rebuild-A-engine-comparison*`.
**Artifact:** `docs/references/2026-05-29-engine-comparison.png` (live three-way on canvas) + эталоны `~/Projects/draft-n-old/mermaid-mr-345/{dagre,elk}-lr.png`.

## Метод

Селектор движка (`Dagre | ELK | Custom`) в окне вставки mermaid (live, vite dev, room `a-engine-compare`). Импортирован один и тот же `sample-2` (`apps/backend/tests/fixtures/sample-2-mermaid.md`, flowchart LR, 4 subgraph'а, 18 узлов, ~24 ребра) тремя движками в одну доску, рядом (offset). Визуальное сравнение с эталонными PNG mermaid.live.

## Результат

| Движок | Путь | Расположение | `<br/>` | Пересечения | Вердикт |
|---|---|---|---|---|---|
| **Dagre** | mermaid-native `createMermaidDiagram` (default) | чистый LR, 4 subgraph'а, компактно — **почти 1:1 с `dagre-lr.png`** | → переносы строк ✅ | ~1-2 | ✅ |
| **ELK** | mermaid-native `createMermaidDiagram` + `mermaidConfig.layout:"elk"` | чистый, 4 subgraph'а — **1:1 с `elk-lr.png`** | → переносы строк ✅ | ~2-3 | ✅ (предпочтение user'а с угловыми стрелками) |
| **Custom** | наш backend (`POST /api/schema/create`, ELK + Pass A/B) | tall, тесно, нахлёст | **литеральный `<br/>`** ❌ | много | ❌ худший |

**Вердикт user'а (визуальный):** dagre/elk воспроизвели *расположение объектов* почти точь-в-точь по образцам; слабое место только соединения (стрелки) — исправимо. Custom — разгромно хуже.

## Что подтверждено на живой доске

- **Селектор работает end-to-end** — три движка дали разный результат (Tasks 7+8 wiring).
- **ELK-loader реально активировался** — elk-раскладка визуально ≠ dagre ⇒ `registerLayoutLoaders` на shared mermaid-инстансе сработал, `engineFallback` НЕ сработал. Закрыт главный риск spec §9 (дедуп mermaid@11.12.2 + регистрация на прямом import).
- **mermaid-native чинит `<br/>` даром** (наш backend пишет литеральный `<br/>`).
- **offset-размещение** развело три импорта без наложения.

## Решение

1. **Движок размещения = mermaid-native** (dagre + elk), оба остаются в селекторе. **elk — предпочтительный** по образцам user'а (особенно с угловыми стрелками). Наш backend-ELK (Pass A/B + variant search) для импорта **отменён** — разгромно проигрывает.
2. **Импорт из mermaid** → следующий шаг продуктизации: вместо tldraw-native объектов `createMermaidDiagram` использовать **наши объекты** (schema-container + node-шейпы), конвертировать **arc → elbow** стрелки, применить стили, разместить во фрейме, присвоить v2-identity.
3. **Самая большая задача (ядро B)** — применять layout-движок к **любой нарисованной схеме** (выделение / внутри контейнера-фрейма), с выбором **direction** и учётом **pin** (позиция/размер фигур и контейнеров). Текущий Cmd-Shift-L (backend-движок) портит схему — это тот же худший движок. B = заменить его dagre-style layered на нарисованном графе + наш arrow router (C).

## Caveats

- mermaid-native = **только импорт из mermaid** (нужен mermaid-исходник + живой браузер/DOM). НЕ покрывает re-layout нарисованного графа и не-mermaid схемы → это отдельная задача B (движок по нарисованному графу, напр. `dagre`/`dagre-d3-es`).
- Сравнение визуальное (crossing-count на глаз), не автоматический скор — для выбора движка достаточно (разница разительная).
