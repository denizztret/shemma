# Reference 02 — InlineAdLoader (iOS architecture)

Эталон от пользователя 2026-05-19.

## Что нарисовано

**Title:** `InlineAdLoader` (жёлтый highlight'ed заголовок поверх диаграммы)

**Containers (visible label сверху):**
- `integration` — содержит `ViewController`, `InlineAdDelegate`, `InlineAdLoaderDelegate`
- `UIView` — содержит `StoriesView`, `BannersView`

**Nodes:**
- `ViewController` (multi-line richText внутри: `ad.delegate = self`, `var ads:`, `[AdSlot: InlineAd]`) — обычный border
- `InlineAdDelegate` — **фиолетовый border** (protocol/delegate)
- `InlineAdLoaderDelegate` — **синий border** (protocol/delegate)
- `InlineAdLoader` — обычный (entry point)
- `StoriesAdLoader` — **серый fill** (internal subclass)
- `StoriesView`, `BannersView` — обычные

**Edges с labels:**
- `ViewController → InlineAdLoader` — `load(slot:)`
- `ViewController → UIView (BannersView area)` — `ads[slot].render()` (**красная стрелка**)
- `InlineAdLoader → StoriesAdLoader`
- `StoriesAdLoader → BannersView`
- `BannersView → InlineAdLoaderDelegate` (синяя)
- `BannersView → InlineAdDelegate` (фиолетовая)
- `InlineAdLoaderDelegate → ViewController` (синяя) — `.loaded(ad, slot)`

## Features Tested

| # | Feature | Shemma support | Tickets |
|---|---|---|---|
| 1 | **Group/container с visible label** | shemma_group существует, но видимый label на самом контейнере — ? | **DRW-079 (new)** |
| 2 | **Color-coded box border** (purple delegate, blue protocol) | Сейчас все ноды имеют дефолтный `color: 'black'` | **DRW-078** (taxonomy) или новый |
| 3 | **Filled box** (gray StoriesAdLoader) | Сейчас `fill: 'none'` всегда | **DRW-078** или новый |
| 4 | **Multi-line code в одной ноде** | Сейчас label — одна строка text | **DRW-080 (new)** |
| 5 | **Цветные edges** (red, purple, blue) | Сейчас все edges `color: 'black'` | **DRW-078** или новый |
| 6 | **Edge label** с кодом (`.loaded(ad, slot)`, `ads[slot].render()`) | shemma_connect kind="..." кладёт в label, но: спецсимволы? | Проверить |
| 7 | **Diagram title** поверх всего | Нет — кандидат на отдельный note/text shape | Низкий приоритет |

## Acceptance

Когда shemma'е MCP даётся задание «нарисуй InlineAdLoader архитектуру» (по тексту описания этого MD), AI должен суметь воспроизвести **8 из 8** features (с учётом всех тикетов выше). Текущий baseline — оцифровка после DRW-076 fix: nodes + edges работают, всё остальное TODO.
