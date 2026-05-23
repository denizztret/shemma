# DRW-111 Manual E2E Test Plan — Visual Fidelity v2

**Цель:** ручная визуальная проверка экспорта в Miro UI всех 6 blocks spec v0.5 + production constraints (real-Miro hotfix).

**Версия для проверки:** 0.24.0+ (tag `0.24.0`, commit `f882278`).

## Pre-flight

1. Daemon на `0.24.0+`:
   ```bash
   shemma daemon stop && shemma daemon start --profile release
   curl -s http://localhost:8787/api/version | jq .version  # должно быть "0.24.0"
   ```
2. Чистая тестовая Miro доска (создать новую через UI или API). НЕ использовать рабочую — экспорт append-only, накопится мусор.
3. Token в `~/.config/shemma/config.json` валидный (probe или live-export не падает на 401).
4. Browser: Chrome/Firefox, авторизованная Miro сессия.

---

## Block 1 — Color mapping (12 named colors)

### 1.1 Все 12 цветов на shapes

**Canvas (новая room):** 12 rectangles в 3 ряда × 4 столбца, каждый со своим цветом из tldraw palette + `fill: solid`:

| row\col | 1 | 2 | 3 | 4 |
|---|---|---|---|---|
| 1 | black | grey | light-violet | violet |
| 2 | blue | light-blue | yellow | orange |
| 3 | green | light-green | light-red | red |

**Verify (Miro UI):**
- [ ] 12 цветных прямоугольников видны.
- [ ] Border + fill цвета **матчат** tldraw palette (визуально close).
- [ ] Точные hex (через "Select shape" → style panel в Miro):
  - black → `#1d1d1d`
  - grey → `#9fa8b2`
  - light-violet → `#e085f4`
  - violet → `#ae3ec9`
  - blue → `#4465e9`
  - light-blue → `#4ba1f1`
  - yellow → `#f1ac4b`
  - orange → `#e16919`
  - green → `#099268`
  - light-green → `#4cb05e`
  - light-red → `#f87777`
  - red → `#e03131`

### 1.2 Fill modes

**Canvas:** 4 одинаковых rectangle (blue color, size m), разные `fill`:
- `none` (default outline)
- `semi` 
- `solid`
- `pattern`

**Verify:**
- [ ] `none` → пустой fill (только blue border).
- [ ] `semi` → blue с opacity ~50%.
- [ ] `solid` → blue с opacity 100%.
- [ ] `pattern` → **визуально идентичен `semi`** (degrade, Miro не поддерживает диагональную штриховку).

### 1.3 Connector colors

**Canvas:** 4 стрелки с разными цветами (`black`, `red`, `green`, `blue`), default size/style.

**Verify:**
- [ ] Каждая стрелка нарисована соответствующим hex'ом (см. таблицу 1.1).
- [ ] Цвет применяется к stroke (НЕ к caption text — у connectors `style.color` отдельное поле, мы его не выставляем).

### 1.4 Sticky note color

**Canvas:** 3 sticky notes: один без явного color (default), один `yellow`, один `red`.

**Verify:**
- [ ] Default sticky → жёлтый (legacy yellow fallback per spec § 4.5).
- [ ] `yellow` → жёлтый Miro sticky.
- [ ] `red` → ближайший красный в Miro sticky enum (`red` или `dark_red`).

---

## Block 2 — Size mapping (4 sizes)

**Canvas:** 4 одинаковых rectangle (blue solid), разные `size`: `s`, `m`, `l`, `xl`.

**Verify (Miro shape style panel):**
- [ ] `s` → fontSize 12, borderWidth 1.0
- [ ] `m` → fontSize 14, borderWidth 2.0
- [ ] `l` → fontSize 20, borderWidth 3.0
- [ ] `xl` → fontSize 30, borderWidth 4.0
- [ ] Borders визуально разной толщины.

**Bonus — connectors:** 4 стрелки разных `size`, проверить `strokeWidth` совпадает с borderWidth scale (1.0/2.0/3.0/4.0).

**Bonus — sticky:** 4 sticky разных size, проверить sticky-specific fontSize scale (14/24/36/48).

---

## Block 3 — Font mapping (4 fonts)

**Canvas:** 4 rectangle с label, разные `font`:
- `draw`
- `sans`
- `serif`
- `mono`

**Verify (Miro shape style panel — fontFamily field):**
- [ ] `draw` → `caveat` (handwriting script, не open_sans).
- [ ] `sans` → `open_sans`.
- [ ] `serif` → `times_new_roman`.
- [ ] `mono` → `roboto_mono`.

**Связанные widgets:** проверить что font применяется к:
- [ ] Shape labels.
- [ ] Sticky note labels.
- [ ] Standalone text widget (`buildTextPayload`).
- [ ] **Connector НЕ должен иметь fontFamily** (Miro 400 — hotfix removed; см. ниже Block 6).

---

## Block 4 — Arrowhead mapping (9 arrowheads)

**Canvas:** 9 стрелок между парами shapes, разные `arrowheadEnd` (start стандартный `none`):

| tldraw | ожидаемый Miro `endStrokeCap` | визуально |
|---|---|---|
| `none` | `none` | без head |
| `arrow` | `arrow` | thin open arrow |
| `triangle` | `filled_triangle` | filled triangle |
| `square` | `none` | **degrade** — нет head |
| `dot` | `filled_oval` | filled circle |
| `diamond` | `filled_diamond` | filled diamond |
| `inverted` | `arrow` | **degrade** — forward arrow (НЕ обратный) |
| `bar` | `none` | **degrade** — нет head |
| `pipe` | `none` | **degrade** — нет head |

**Verify:**
- [ ] Все 9 стрелок созданы (никаких 400).
- [ ] Видуально соответствуют ожидаемому.
- [ ] `square`/`bar`/`pipe` — стрелки без endhead (плавно заканчиваются).
- [ ] `inverted` — обычная forward стрелка (направление потеряно — known limitation).

**Bonus — combos:** 1 стрелка с `arrowheadStart: diamond` + `arrowheadEnd: triangle` — проверить что оба cap'а нарисованы (start = filled_diamond, end = filled_triangle).

---

## Block 5 — Frame-as-shape mode

### 5.1 Single frame с детьми

**Canvas:**
- 1 boundary frame "Backend" (blue, size m) с 3 shapes внутри:
  - Service A (rectangle, red, solid)
  - Service B (ellipse, green, semi)
  - DB (rhombus, blue, none)

**Verify в Miro:**
- [ ] Frame отрисован как **rectangle** с label "Backend" наверху (`textAlign:center, textAlignVertical:top`), белый fill, blue border (`#4465e9`), borderWidth 2.0.
- [ ] **НЕТ titlebar с серым фоном** (это была бы Miro frame widget — теперь shape).
- [ ] 3 children внутри (visually inside the frame's bounds).
- [ ] Click на любом child → child selected.
- [ ] **Group widget**: Right-click → "Edit group" должен показать что frame rectangle + 3 children в одной группе.
- [ ] **Drag frame rectangle** → весь блок (frame + 3 children) движется вместе.

### 5.2 Nested frames (FLAT outer per Miro at-most-one-group constraint)

**Canvas:**
- Outer frame F1 "App" (blue, size l), inside:
  - Inner frame F2 "Backend" (green, size m), inside:
    - Service X (rectangle, red, solid)
    - Service Y (ellipse, red, semi)
  - Standalone shape S1 "Frontend" (rectangle, orange, solid)

**Verify в Miro:**
- [ ] F1 — белый rectangle с "App" вверху, blue thick border (l → borderWidth 3.0).
- [ ] F2 — белый rectangle внутри F1, "Backend" вверху, green border 2.0.
- [ ] Service X, Service Y внутри F2.
- [ ] S1 внутри F1 (но НЕ внутри F2).
- [ ] **Inner group g_F2**: frame F2 rect + Service X + Service Y = 3 items.
- [ ] **Outer group g_F1**: frame F1 rect + S1 = **2 items** (НЕ 5! — Service X/Y/F2 уже в g_F2; per Miro constraint outer не может их повторно вложить).
- [ ] **Drag inner frame F2** → F2 rect + Service X + Service Y движутся вместе. F1 + S1 остаются.
- [ ] **Drag outer frame F1** → F1 rect + S1 движутся. F2 + Service X + Service Y остаются! (Это known UX gap; альтернативы нет из-за Miro constraint.)

### 5.3 Empty frame (no children) — skip group

**Canvas:** 1 пустой frame "Empty Container" (без children, size m).

**Verify:**
- [ ] Frame rectangle создан (видим белый rectangle с title).
- [ ] **Group widget НЕ создан** для этого frame (Miro min 2 items).
- [ ] В tracking JSON `room.meta.miroExports[boardId].groups` — нет entry для этого frame.

### 5.4 Single-child frame — DOES create group

**Canvas:** 1 frame "Lonely" с 1 child shape.

**Verify:**
- [ ] Group widget создан (frame rect + 1 child = 2 items = meets Miro min).
- [ ] Group entry присутствует в tracking.

### 5.5 Frame border colors через tldraw color

**Canvas:** 4 frames разных colors (`black`, `blue`, `green`, `red`), каждый с 1 child.

**Verify:**
- [ ] borderColor каждого frame matches tldraw palette hex (см. Block 1.1).
- [ ] borderWidth = размер (size m default = 2.0).

---

## Block 6 — Connector style (hotfix coverage)

### 6.1 Connector style fields applied

**Canvas:** 1 стрелка между 2 shapes:
- color: red
- size: l
- font: mono (это поле НЕ применяется к connector style)
- arrowheadStart: none
- arrowheadEnd: triangle

**Verify через Miro UI:**
- [ ] Stroke color = `#e03131`.
- [ ] Stroke width = 3.0 (size l).
- [ ] End cap = filled triangle.
- [ ] Start cap = none.

### 6.2 Connector style does NOT include fontFamily/fontSize (Bug 1 hotfix)

**Verify через GET API**:
```bash
TOKEN=$(jq -r .miro.token ~/.config/shemma/config.json)
curl -s "https://api.miro.com/v2/boards/<BOARD>/connectors?limit=5" \
  -H "Authorization: Bearer $TOKEN" -H "User-Agent: Mozilla/5.0" \
  | jq '.data[].style | {strokeColor, strokeWidth, startStrokeCap, endStrokeCap, fontFamily, fontSize}'
```

- [ ] Все connectors имеют strokeColor/strokeWidth/startStrokeCap/endStrokeCap.
- [ ] fontFamily/fontSize отсутствуют в payload (если Miro и не вернёт их, не будет 400 при создании).

---

## Block 7 — Standalone text widget

**Canvas:** 3 standalone text shapes (НЕ внутри frame):
- "Red mono" — color: red, font: mono, size: m
- "Blue large" — color: blue, font: sans, size: l
- "Default" — без явных props

**Verify:**
- [ ] Text widget создан в Miro (НЕ shape с label, отдельный type `text`).
- [ ] Color field применяется: red → `#e03131`, blue → `#4465e9`.
- [ ] fontFamily: `roboto_mono`, `open_sans`.
- [ ] fontSize: 14 (m), 20 (l).
- [ ] textAlign применяется.

---

## Block 8 — Tracking + idempotent re-export

### 8.1 Tracking persistence

**После любого export:**
```bash
jq '.meta.miroExports["<BOARD_ID>"] | {boardName, lastExportedAt, items_count: (.items|length), connectors_count: (.connectors|length), groups_count: (.groups|length)}' \
  ~/.shemma/canvas/<ROOM>.json
```

- [ ] `items`, `connectors`, `groups` все три мapping'а присутствуют.
- [ ] `groups` field — новый в DRW-111 (frame elementId → Miro group widget id).

### 8.2 Re-export overwrites tracking, appends на server

**Action:** Re-export тот же room в тот же boardId.

**Verify:**
- [ ] Export response успешный (нет 400).
- [ ] `lastExportedAt` обновился.
- [ ] `items`/`connectors`/`groups` ids в tracking ПОЛНОСТЬЮ заменились новыми (для тех же elementId).
- [ ] На Miro доске **двойное количество элементов** (append-only).
- [ ] Старые группы остались на доске (orphaned — не удаляются).

---

## Block 9 — Error scenarios

### 9.1 Invalid board id

**Action:** Export с `boardId: "nonsense"`.

**Verify:**
- [ ] Response error код `http-error` или подобный.
- [ ] Tracking не модифицирован для этого boardId.

### 9.2 Invalid token

**Action:** Подменить `miro.token` на gibberish, restart daemon, export.

**Verify:**
- [ ] Response error 401.
- [ ] Error message guides пользователя re-copy token.

### 9.3 Mid-export rate-limit (если воспроизведётся)

**Action:** Export большого room (50+ items), повторный сразу за первым.

**Verify:**
- [ ] 429 не падает с unrecoverable error — graceful.
- [ ] Partial commits сохраняются (то что успело пройти — в tracking).

---

## Block 10 — Visual fidelity comparison side-by-side

**Action:** Открыть tldraw room в shemma + Miro board в соседней вкладке после export.

**Verify (subjective):**
- [ ] Layout соответствует (relative positions preserved).
- [ ] Color scheme узнаваема — Miro доска визуально похожа на оригинал.
- [ ] Frame boundaries чётко видны (rectangles с labels).
- [ ] Стрелки идут к правильным shape'ам.
- [ ] Sticky notes выглядят как sticky notes (не shapes).
- [ ] Text widgets — без рамки, просто текст.

**Known divergences (expected):**
- Pattern fill ≡ semi (no diag-fill).
- `square`/`bar`/`pipe` arrowheads без head.
- `inverted` arrowhead — forward.
- Caveat (script) font для `draw` — отличается от tldraw handwriting render.

---

## Дополнительно — edge cases

### Empty/whitespace labels

**Canvas:** Shape с пустой label, frame с пустым name.

**Verify:**
- [ ] Не падает на export.
- [ ] Empty title корректно отображается (just rectangle without label).

### Many sub-frames (3+ levels deep)

**Canvas:** F1 ⊃ F2 ⊃ F3 ⊃ shape.

**Verify:**
- [ ] Все 3 frame rectangles созданы.
- [ ] g_F3 = [F3.rect, child], g_F2 = [F2.rect] (1 item! — НЕ создаётся, single child уже claimed in g_F3), g_F1 = [F1.rect] (skip).
- [ ] Actually проверить точно через GET groups — depending on Pass C algorithm выбор может варьироваться.

### Unicode / emoji labels

**Canvas:** Shape с label "🚀 Сервис 服务".

**Verify:**
- [ ] Создаётся без 400.
- [ ] Текст рендерится корректно (UTF-8 preserved).

### Очень длинные labels

**Canvas:** Shape с label 200+ символов.

**Verify:**
- [ ] Не падает.
- [ ] Текст либо wrapped, либо truncated (Miro UI behavior).

---

## Итоговый чек-лист

Что должно быть проверено end-to-end:
- [ ] Block 1 (color): 12 colors × 3 widgets × 4 fill modes.
- [ ] Block 2 (size): 4 sizes × 3 widget types (shape/connector/sticky).
- [ ] Block 3 (font): 4 fonts × 3 widget types.
- [ ] Block 4 (arrowhead): 9 arrowheads.
- [ ] Block 5 (frame): single, nested (flat constraint), empty, single-child, custom-color border.
- [ ] Block 6 (connector hotfix): style fields, fontFamily/fontSize absence.
- [ ] Block 7 (text widget): color/font/size.
- [ ] Block 8 (tracking): persistence, re-export idempotency.
- [ ] Block 9 (errors): invalid board/token/rate-limit.
- [ ] Block 10 (side-by-side): general visual fidelity.

**Финал:** записать результаты в этот файл (отметить чекбоксы) после прохода в отдельном PR `docs(drw-111): manual E2E results 2026-XX-XX`.
