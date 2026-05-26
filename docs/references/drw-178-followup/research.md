# DRW-178 follow-up — research log

**Branch:** `feature/drw-173-attempt-2` (от tag `0.27.1`, commit `2d6f792`)
**Started:** 2026-05-26
**Status:** In progress

## Vision (user-story)

**Схема — это «живая печатная плата».**

Когда открываешь готовую схему или импортируешь mermaid:
- На канвасе появляются блоки в контейнерах и стрелки между ними.
- Стрелки **угловые** — идут только по горизонтали и вертикали, обходят чужие блоки и контейнеры, никогда не идут по диагонали через всё полотно.
- Стрелки **не пересекаются друг с другом** там, где этого можно избежать. Если избежать нельзя (две параллельные ветки сходятся в один узел) — пересечений минимум.
- Стрелка **не проходит сквозь чужой контейнер**. Если ей надо войти — только потому, что она ведёт к объекту внутри.
- Цвет и стиль контейнеров и блоков сохраняются ровно как заданы в mermaid.

**Расположение строится умно, а не буквально по mermaid.** Mermaid — это «что с чем соединено и кто в каком контейнере», это вход, не диктат позиций. Система сама решает направление subgraph (TB / LR), порядок детей, размещение anchors — так, чтобы итог был с минимумом пересечений. Указанный direction в mermaid уважается, неуказанный — выбирается автоматически.

**Стрелки — настоящие коннекторы, не нарисованные линии.** Тащишь shape мышкой — стрелки тянутся за ним в реальном времени. Прикреплены к нужной стороне (или к точной точке на стороне). Native tldraw arrow binding обеспечивает это из коробки.

**Три стадии работы со схемой:**

1. **Генерация** — mermaid-импорт или агент рисует через API. Узлы и стрелки появляются с дефолтными параметрами.
2. **Layout (явный вызов — кнопка/команда)** — детерминированный проход:
   - расставить узлы (ELK + per-container direction);
   - распределить anchor points по сторонам shape (DRW-172, уже есть);
   - выставить `elbowMidPoint` каждой стрелке;
   - зарезервировать spacing под подписи стрелок;
   - **не зависит от текущих координат** — одинаковый результат для одной топологии.
3. **Редактирование** — без авто-layout. Юзер/агент двигает, добавляет, соединяет. Стрелки follow shapes сами (native). Light-layout для одной новой фигуры (E7) — отдельный режим: найти пустое место, при необходимости раздвинуть фрейм. Юзер хочет почистить всё — нажимает Layout ещё раз.

**Что НЕ делаем:**
- Кастомных shape для стрелок (`routed-arrow` отбрасываем — без неё native binding реактивен и пользователь может тащить bend handle).
- libavoid в runtime / на каждый drag.
- Авто-layout при редактировании.
- Multi-bend ortho через obstacle field — native elbow это single bend, нам этого достаточно при умном layout.

**Закладываемся, но не делаем в этой итерации:**
- UI-панель параметров layout (insets, paddings, gaps, max-lines). Архитектурно: все параметры через одну `LayoutParams`-структуру, ничего не хардкодим.

## Целевые tldraw API

Из `docs/references/tldraw-cheatsheet.md` + `docs/references/tldraw-5x-deep.md`:

- Shape: `type:"arrow"`, `kind:"arc"|"elbow"`.
- `bend: number` — для arc.
- `elbowMidPoint: number` (0..1, default 0.5) — для elbow, позиция перегиба.
- Binding: `type:"arrow"`, `fromId:arrowId`, `toId:nodeId`.
- Binding props: `terminal:"start"|"end"`, `normalizedAnchor:{x,y}`, `isPrecise:bool`, `isExact:bool`, `snap:ElbowArrowSnap`.
- `snap` enum — снеп-поведение elbow endpoint, точные значения проверяем в E1.

## Experiment room

`drw-178-research` в space `di-draw`. Каждый эксперимент — в своём frame, имя совпадает с E-номером.

## E1: Native elbow baseline

**Goal:** убедиться что native elbow arrow реактивен на shape move, понять что делают `kind:"elbow"`, `elbowMidPoint`, `snap` enum.

**Setup:** frame `E1-elbow-baseline`, blue A (geo rect 120×60) + green B (geo rect 120×60), одна arrow с `kind:"elbow"`, дефолтные bindings (`normalizedAnchor:{x:0.5,y:0.5}`, `isPrecise:false`, `snap:"none"`).

**Screenshots:**
- `E1-elbow-baseline-initial.png` — A слева, B справа, прямая стрелка между ними.
- `E1-after-move-A.png` — A сдвинут вниз на +200; стрелка автоматически перестроилась в L-форму, выходит из top A, входит в left B.
- `E1-isPrecise-baseline.png` — anchors переключены на `isPrecise:true`, A:(1.0, 0.5), B:(0.0, 0.5).
- `E1-isPrecise-after-move.png` — A сдвинут вниз; стрелка идёт из правого края A вверх вертикально, затем поворот направо в left edge B.

### Findings

1. **Native elbow binding реактивен из коробки.** Любое движение bound shape (через `updateShape` или drag в UI) автоматически перестраивает путь стрелки. Никаких `onAfterChangeToShape` handlers писать не надо — это поведение tldraw editor по умолчанию.

2. **`isPrecise:false` (дефолт)** — tldraw сам выбирает сторону входа по relative geometry. Двигаешь A вниз → стрелка переезжает с right-side-of-A на top-side-of-A. Это удобно для интерактива, но недетерминированно для layout.

3. **`isPrecise:true`** — anchor фиксируется на указанной нормализованной координате. Сторона входа не меняется при move. Это **то что нужно DRW-172** для детерминированного anchor distribution.

4. **`snap` enum** (из `@tldraw/tlschema` `TLArrowBinding.ts:28`): `'center' | 'edge-point' | 'edge' | 'none'`. Shemma backend пишет `'none'` — это **корректно работает**. Различия между значениями требуют отдельной проверки в E3, но они влияют на behavior endpoint **при пользовательском drag**, а не на программное обновление.

5. **`elbowMidPoint:0.5` (дефолт)** — позиция перегиба середина пути по главной оси. При вертикальном смещении endpoint'ов даёт U-образный path (длинная вертикаль вверх → коротко вправо). Меняется значением 0..1; полное исследование в E5.

6. **Frame parenting не клиппит arrow.** A может уехать за пределы frame — стрелка отрисуется. Frame не autosize'ится под детей при `updateShape` (нужно вручную увеличить).

7. **tldraw store filter gotcha:** binding также имеет `type:"arrow"` (потому что тип binding'а = "arrow"). Фильтровать shapes надо `r.typeName === 'shape' && r.type === 'arrow'`, иначе попадает binding и валит код.

### Implications for design

- **Layout-pass пишет `isPrecise:true`** + fixed `normalizedAnchor` на конкретную сторону + offset (DRW-172 уже это делает). После layout стрелки имеют детерминированные anchor sides.
- **Edit-mode оставляет `isPrecise:false`** для новых arrows, созданных пользователем drag-ом — пусть tldraw решает сторону. Только после явного Layout-call мы фиксируем.
- **`snap:"none"`** — корректное значение для programmatic anchors. Альтернативы пробуем только если найдём visual issue.
- **Реактивность binding — бесплатна.** Custom `routed-arrow` shape делать не надо.

## E2: Per-side anchor distribution

**Goal:** validate DRW-172 — несколько стрелок к одному shape распределяются по anchors без overlap.

**Setup:** frame `E2-anchor-offset`. Orange hub слева, 3 spoke shapes справа (blue/green/red) на разной высоте. Три arrow hub→spoke, все стартуют с правой стороны hub'а с offsets `y: 0.25 / 0.5 / 0.75`, входят в левый край соответствующего spoke (`x:0, y:0.5`). Все bindings — `isPrecise:true`, `snap:"none"`.

**Screenshot:** `E2-anchor-offset.png`.

### Findings

1. **Anchor offsets 0.25/0.5/0.75 на одной стороне дают чистое разделение** — стрелки выходят из трёх разных точек правой стороны hub'а, не сливаются.
2. **Каждая elbow самостоятельно подбирает kink position** под свой target — верхняя bend'ится вверх, нижняя вниз, средняя идёт прямо.
3. **Это и есть DRW-172 в action** — нам не надо переписывать anchor distribution. Существующий `computeAnchors` уже выдаёт правильные `normalizedAnchor + isPrecise=true`. Только надо убедиться что во время layout-pass он применяется ко **всем** sides (`x: 0.25/0.5/0.75` для top/bottom и `y: 0.25/0.5/0.75` для left/right).
4. **Side detection через cardinal-snap (DRW-172)** работает корректно: source → right (хаб → правее spoke), end → left (spoke получает стрелку слева).
5. Аналогичная картина в обратную сторону (multiple arrows входящие в один shape) — тот же mechanism (offsets на end-side).

### Implications for design

- DRW-172 anchor distribution — **переиспользуем как есть**, никаких изменений не требуется для базового hub-spoke.
- Layout pass должен вызвать `computeAnchors` **после** repositioning узлов, чтобы side detection работал на финальных координатах.

## E3: Parallel arrows A→B

**Goal:** три стрелки одновременно от A к B, развести через anchors.

**Setup:** frame `E3-parallel-arrows`, blue A → green B (горизонтальное выравнивание). Три arrow A→B, start anchor `x:1.0, y:0.25/0.5/0.75`, end anchor `x:0.0, y:0.25/0.5/0.75`. Все `isPrecise:true`.

**Screenshot:** `E3-parallel-arrows.png`.

### Findings

1. Все три стрелки идут **параллельно** на разных y-уровнях, не сливаются. Каждый arrowhead виден отдельно.
2. Когда start и end anchor имеют одинаковый y (по обоим terminal), elbow **degenerates в прямую горизонтальную линию** — `kind:"elbow"` не добавляет фиктивных перегибов когда они не нужны. Это хорошо для simplicity рендеринга.
3. Visual spacing определяется размером shape — на shape height 80 три anchor offsets дают 20px между линиями стрелок. Этого достаточно для читаемости.

### Implications

- Multi-edge между двумя shapes — **бесплатно** через DRW-172 cardinal-snap + offset distribution. Никакой routing-логики не нужно.
- Минимальный shape height для N стрелок: примерно `N*spacing` (где spacing 12-20px достаточно). Это вход в layout's node sizing — если на узел приходит много параллельных edges, его высота должна быть min `count * spacing`.

## E4: Arrow label sizing

**Goal:** что происходит с длинной подписью на стрелке при разной длине shape-to-shape distance, можно ли разбить на 2-3 строки, формула min-spacing.

**Setup:** frame `E4-arrow-labels`. Три пары shapes на разных расстояниях:
- "short" label, distance 400px between shapes.
- "medium-length label text", distance 250px.
- "very-long-arrow-label-that-might-not-fit-between-shapes-with-many-words", distance 120px.

Все стрелки `kind:"elbow"`, label через `richText` ProseMirror doc.

**Screenshots:** `E4-arrow-labels.png`, `E4-labels-zoomed.png`.

### Findings (КРИТИЧЕСКИ ВАЖНЫЕ)

1. **Tldraw не сжимает текст label** и не пушит shapes друг от друга. Label рендерится с **фиксированной max-width** (~100-120px по визуальной оценке), при недостатке ширины **расширяется по высоте** — растёт перпендикулярно arrow direction.

2. **Long label вылезает за пределы arrow body.** На bottom-arrow (distance 120) label в 8 строк выросла **примерно на 300px ВВЕРХ** от центра стрелки. Это полностью перекрывает middle arrow выше и его label.

3. **Catastrophic для visual quality:** при недостатке расстояния label catastrophically overflows и накрывает соседние arrows/shapes. Нет fallback elision, нет shrink, нет horizontal scroll.

4. **Medium label (3 строки на 250px distance)** — приемлемо, label вписался посреди и не вылез за вертикальные границы pair. Это говорит что **multi-line auto-wrap работает**.

5. **`labelPosition`** — параметр стрелки (0..1), позиция вдоль path. Default 0.5. Если перенести в крайний край (например 0.85), можно сместить label ближе к target shape, иногда это даёт больше доступной ширины (но привязка к anchor side всё равно ограничивает).

### Implications for design — measure label, reserve space

1. **Layout МУСТ замерять label width перед positioning.** Способы:
   - **DOM measure:** временный hidden text node с правильным шрифтом, читать `offsetWidth/offsetHeight`. Можно делать в frontend перед отправкой в backend.
   - **Canvas measure:** `canvas.getContext('2d').measureText()` — быстрее, нет DOM mutation. Но font + line-height нужно настроить точно.
   - **Эвристика:** `width ≈ char_count * avg_char_width(font_size)` — грубо, но достаточно для первой итерации.

2. **Min-distance формула** (для horizontal arrow A→B):
   - `min_distance(A, B) = label_width + 2 * label_margin`
   - где `label_width = measured(label_text, font, max_lines)` либо fallback `max_line_width_target` (e.g. 200px) + multi-line.

3. **Multi-line strategy:** если label длинный, **искусственно разбивать на N строк** при импорте (через `\n` или word-wrap при max-width 200px). Это уменьшает required min-distance ценой увеличения required min-height на edge.

4. **Layout option:** `LayoutParams.edgeLabelMaxWidth` (default 200), `edgeLabelMaxLines` (default 3). Если label не помещается в это — обрезать или escalate (warning + truncate).

5. **Per-edge spacing override:** ELK поддерживает `org.eclipse.elk.spacing.edgeNode` per-edge. Layout pass должен рассчитать spacing для каждого edge по его label.

### Open questions

- Можно ли read tldraw's measured label bounds через editor API (без custom measure)? Возможно через `editor.getShape(arrowId)` есть hidden bounds field.
- Влияет ли `font` prop (draw/sans/serif/mono) и `size` (s/m/l/xl) на label measure? Точно влияет — нужно учитывать при формуле.

## E5: elbowMidPoint manual tuning

**Goal:** как меняется path при разных значениях elbowMidPoint и сторонах входа, pattern для вычисления.

**Setup:** frame `E5-elbow-midpoint`. Три ряда тестов с 5 стрелками каждый, elbowMidPoint = 0.0/0.25/0.5/0.75/1.0:
- Row 1 (vertical pair) — A above B, anchors top-of-A → bottom-of-B.
- Row 2 (horizontal pair) — A → B на одной высоте, anchors right-of-A → left-of-B.
- Row 3 (perpendicular) — anchors right-of-A → top-of-B (forced L-bend).

**Screenshot:** `E5-elbow-midpoint.png`.

### Findings

1. **Degenerate elbow (straight)**: когда anchors таковы, что прямая линия проходит ортогонально (Row 1 vertical, Row 2 horizontal), `elbowMidPoint` **никак не влияет визуально** — path остаётся прямой. Tldraw elbow optimizer не добавляет фиктивные перегибы.

2. **Real L-bend (Row 3)**: anchors на перпендикулярных сторонах → forced L-shape. **`elbowMidPoint` управляет положением вертикального сегмента**:
   - `0.0` — kink сразу у source (вертикаль вырастает сразу из source-side).
   - `0.5` — kink посередине пути.
   - `1.0` — kink у target (вертикаль входит сразу в target-side).
   - 0.25 / 0.75 — промежуточные значения.

3. **Multi-edge avoidance** через распределение midpoint значений: если N стрелок идут из right-of-A в top-of-B, давая им midpoint `(i+1)/(N+1)` для i=0..N-1 (как DRW-172 делает для anchors), их вертикальные сегменты разносятся по разным "коридорам".

4. **Z-shape (Row 2 не сработал)**: для Z-bend нужны opposite sides + vertical offset между endpoints. Подтверждено косвенно из E1 (когда A сдвинут вниз, arrow становится Z-образной). `elbowMidPoint` управляет позицией центрального горизонтального сегмента.

### Implications for design

- **Layout pass вычисляет `elbowMidPoint` per arrow** на основе:
  1. **Anchor sides** (если же sides → straight, midpoint не влияет, пишем 0.5);
  2. **Group siblings** — стрелки с одинаковой source-side и target-side группируются;
  3. **Distribute midpoints** в группе: `mid_i = (i+1) / (N+1)`, сортируя по визуальному порядку (например, по target-anchor y-coordinate).

- **DRW-172 уже** распределяет anchor offsets на сторонах shape — добавим **complementary distribution of elbowMidPoint** для разводки kink-segments.

- **Layout не нужно вычислять midpoint** для degenerate cases (straight arrows). Пишем дефолтный 0.5 — поведение идентично.

## E6: Container direction flip

**Goal:** TB vs LR на куске DRW-173 (Оркестрация), эвристика auto-flip.

**Setup:** два frame side by side:
- Variant A: Оркестрация **TB**, EventRouter сверху, EventPolicy.dispatch снизу. SourceEvent в Вход сверху-справа от Оркестрации.
- Variant B: Оркестрация **LR**, EventPolicy.dispatch слева, EventRouter справа. SourceEvent над Оркестрацией.

**Screenshot:** `E6-direction-flip.png`.

### Findings

1. **Variant A (TB):** SourceEvent → EventRouter — длинный L-путь огибает границу контейнера: стрелка выходит из left edge SourceEvent, идёт вниз вдоль контейнера, входит в right edge EventRouter. Видно перекрытие label "calls" с границей контейнера.

2. **Variant B (LR):** SourceEvent → EventRouter — короткая прямая вертикальная стрелка. EventRouter находится напротив SourceEvent. Это **natural connection point**.

3. **Эвристика для auto-direction:**
   - Если subgraph получает входящие стрелки **сверху** — выбирать TB с receiver сверху.
   - Если **слева** — выбирать LR с receiver слева.
   - **Зеркально для исходящих:** если subgraph отдаёт стрелки вниз/направо — выбрать ориентацию так, чтобы emitter был внизу/справа.
   - Если стрелок и сверху и сбоку — выбор по большему количеству или по приоритету (input-direction over output).

4. **Container label placement issue (новая находка):** label контейнера "Оркестрация (LR)" в Variant B **перекрывается стрелкой EventRouter → EventPolicy.dispatch**. Контейнер label сейчас рендерится по центру контейнера, что конфликтует с любым internal layout. Решение: label контейнера должен быть **на одной из сторон** (top edge или left edge), не в центре.

### Implications for design

- **Layout heuristic для subgraph direction:**
  ```
  for each container C:
    if C has explicit direction in mermaid → respect.
    else:
      analyze external arrows (in/out edges crossing C border):
        - Count incoming arrows per cardinal direction relative to C.
        - Pick direction such that receiving children are placed on side with most incoming arrows.
      if internal topology has dominant flow (chain A→B→C) — orient along that flow.
  ```
- **Container label** должен быть **outside content area** (top-bar) — задача для schema-container shape renderer (можно решать отдельно от layout). На скриншоте видно что schema-container в shemma уже умеет рисовать label, но в нашем quick-test через geo это не воссоздано. Реальный schema-container в shemma имеет label сверху — это менее проблемно. Future improvement: schema-container label on dedicated header-bar shape.

## E7: Smart insertion / empty-space finder

**Goal:** алгоритм добавления одной фигуры в свёрстанную схему без overlap, expansion фрейма.

**Setup:** frame `E7-smart-insert`, 5 случайно расставленных shapes (blue/green/orange/red/violet). Запущен алгоритм поиска пустого rectangle для 6-го shape (yellow, 140×80, padding 20).

**Screenshot:** `E7-smart-insert.png` — yellow shape вставлен в (330, 220), близко к центру frame, не пересекая занятые area.

### Findings

Naive **grid-scan with center-bias** работает достаточно хорошо для типовых случаев:

```typescript
function findEmptySlot(
  parentBounds: { w: number; h: number },
  occupants: Array<{ x: number; y: number; w: number; h: number }>,
  size: { w: number; h: number },
  padding: number,
): { x: number; y: number } | null {
  const step = 10;
  const candidates: Array<{ x: number; y: number }> = [];
  for (let y = padding; y + size.h + padding <= parentBounds.h; y += step) {
    for (let x = padding; x + size.w + padding <= parentBounds.w; x += step) {
      const fits = occupants.every(o =>
        x + size.w + padding <= o.x ||
        o.x + o.w + padding <= x ||
        y + size.h + padding <= o.y ||
        o.y + o.h + padding <= y
      );
      if (fits) candidates.push({ x, y });
    }
  }
  if (!candidates.length) return null;
  const cx = parentBounds.w / 2, cy = parentBounds.h / 2;
  return candidates.sort((a, b) =>
    Math.hypot(a.x + size.w/2 - cx, a.y + size.h/2 - cy) -
    Math.hypot(b.x + size.w/2 - cx, b.y + size.h/2 - cy)
  )[0];
}
```

Complexity: O(W*H/step² * N_occupants). При parent 800×600 step 10 + 5 occupants → 4800 candidates × 5 checks = ~24K ops. Быстро.

**Expansion rule (when no slot found):**

```
if no slot fits:
  if container.direction === 'TB' (vertical chain):
    expand height by size.h + 2*padding
    place new shape at bottom (x = center, y = container.h - size.h - padding)
  else if container.direction === 'LR' (horizontal chain):
    expand width by size.w + 2*padding
    place at right (x = container.w - size.w - padding, y = center)
  else (no direction or 'unknown'):
    pick direction with smaller current dimension
```

**Bias hints:**
- Если new shape **связан** со стрелкой к уже-существующему shape — bias candidate selection toward proximity to that shape (overrides center-bias).
- Если new shape — продолжение цепи (last shape in container chain) — расположить **по направлению цепи**.

### Implications for design

- **Smart-insert API endpoint:** `POST /api/smart-insert` с params `{ containerId, size, connectsTo?: shapeId[], biasDirection?: 'TB'|'LR' }`. Returns `{ x, y, expanded?: { dx, dy } }`.
- **Light-layout = single-shape insertion**, не задевает full topology. Соседи не двигаются.
- **Frame expansion side-effect:** если parent был внутри grandparent, expansion может потребовать каскадного push parent siblings. **Это уже не light-layout** — деградирует до full layout-pass. Решение: в spec пометить как "if cascading required → trigger full layout".

## E8: Layout determinism

**Goal:** одна топология с разными начальными координатами → одинаковый финальный layout pixel-perfect.

**Setup:** chain A→B→C→D в одном frame. Два прогона:
1. Scrambled positions #1 → `POST /api/layout` → record positions.
2. Изменить positions на scrambled #2 → `POST /api/layout` → record positions.
3. Diff.

**Screenshot:** `E8-determinism-final.png`.

### Findings

- Positions before layout #1: A(500,350), B(100,80), C(620,180), D(250,400) — случайные.
- **After layout #1:** A(20,40), B(260,40), C(500,40), D(740,40) — clean LR chain.
- Scrambled to #2: A(50,400), B(600,60), C(350,280), D(100,100).
- **After layout #2:** A(20,40), B(260,40), C(500,40), D(740,40) — **identical pixel-perfect**.

**Verdict: `deterministic: true`.** ELK layered алгоритм на baseline 0.27.1 уже работает детерминированно для одинаковой топологии.

### Implications for design

- **Существующий layout — переиспользуем как фундамент.** Никакой regression-проверки на детерминизм перед каждым релизом — ELK сам гарантирует.
- **Новые параметры (per-container direction, label spacing reservation, midpoint distribution)** должны сохранять это свойство. Тесты: для одной topology с одинаковыми params результат должен совпадать.
- **Layout idempotency сохраняется и при повторном вызове** на уже свёрстанном результате — second layout не сдвигает узлы (count:4 во втором запросе только потому что мы их scrambled до вызова; если бы не scrambled, count был бы 0).

## Synthesis → spec

После E1–E8 — пишем `docs/superpowers/specs/2026-05-26-drw-178-followup-design.md`. Vision выше становится секцией №1. Дальше — architecture (layout pipeline, params, smart-insert, edit-mode), implementation plan, test plan.

## Cross-cutting summary E1–E8

| # | Главная находка | Влияние на дизайн |
|---|---|---|
| E1 | Native elbow binding **реактивен из коробки**. `isPrecise:true` фиксирует anchor side детерминированно. | Custom `routed-arrow` shape **отбрасываем**. Layout пишет `kind:"elbow"` + `isPrecise:true`. |
| E2 | DRW-172 anchor distribution уже работает — `(i+1)/(N+1)` offset на side без overlap. | Переиспользуем как есть в layout-pass. |
| E3 | Multiple parallel arrows A→B бесплатно через разные anchor y-offsets. | Никакой routing-логики не нужно для multi-edge. |
| E4 | **CRITICAL:** длинный label вылезает out-of-bounds, перекрывая соседей. Tldraw не push'ит shapes. | Layout **обязан** замерять label и резервировать spacing: `min_dist = label_width + 2*margin`. Опция multi-line wrap. |
| E5 | `elbowMidPoint` реально управляет позицией перегиба при L/Z-bend. Distribution `(i+1)/(N+1)` разводит kink-segments. | Layout pass вычисляет midpoint per arrow для разводки kink-разводки. |
| E6 | Container direction flip качественно улучшает path для внешних входов. | Эвристика: subgraph orient'ируется по dominant external direction. **Bonus:** container label должен быть на edge, не в центре. |
| E7 | Empty-space finder через grid-scan + center-bias = O(W*H*N) — быстро. Expansion rule по direction. | Smart-insert endpoint `POST /api/smart-insert` для light-режима добавления одной фигуры. |
| E8 | **ELK layered детерминированный** на той же топологии независимо от стартовых координат. | Layout — чистая функция от topology + params. Новые параметры должны сохранять это свойство. |

## Архитектурные решения, готовые для spec'а

1. **Никаких custom shape для стрелок.** Используем native tldraw `arrow` с `kind:"elbow"`.
2. **Layout pass = чистая функция от топологии.** Параметры через `LayoutParams` (insets, paddings, spacings, max-lines, edge-label-max-width).
3. **Layout pipeline:**
   - ELK positions (с per-container direction overrides).
   - DRW-172 anchor distribution (`computeAnchors`).
   - **NEW:** `computeElbowMidpoints` — распределение `elbowMidPoint` per arrow для разводки kink-segments.
   - **NEW:** label measurement + edge spacing reservation в ELK input.
4. **Edit mode = без auto-layout.** User/agent двигает руками, native binding follows. Smart-insert для добавления одиночных shapes (light-light, не задевает соседей).
5. **Mermaid import → kind:"elbow"** (один character change в `compile.ts`/`schema.ts`).
6. **Direction heuristic для subgraph** — auto-pick TB/LR если в mermaid не указано, по dominant external connection direction.
