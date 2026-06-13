# Layout Фаза 4 Implementation Plan (DRW-246 + DRW-247)

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development.
> Спека: `docs/superpowers/specs/2026-06-13-layout-phase4-placement-design.md` — читать ПЕРЕД задачей.
> T6 (live-верификация) выполняет координатор сам, не сабагент.

**Goal:** Невыразимые маршруты чинятся сдвигом блока (arc — fallback); листовые пучки укладываются сеткой.

**Architecture:** Два чистых модуля (`leaf-bundles.ts`, `edge-routing-shift.ts`) + точечная интеграция в `elk-layout.ts` (супер-узлы до ELK / разворот после Ф2) и `edge-routing.ts` (shift-прогон внутри routing-пасса, рекурсия глубиной 1).

**Tech stack:** TypeScript strict, bun:test, tldraw 5.x, elkjs, libavoid-js (WASM).

**Инварианты (все задачи):** Ф1-Ф3 поведение без пучков/сдвигов байт-в-байт прежнее; пины (`meta.pinned`, `meta.didrawSizePinned`) неприкосновенны; детерминизм (стабильные tie-break'и, никаких Math.random/Date.now); тесты чистых функций — без editor/ELK/WASM. После каждой задачи: `bun test --cwd apps/frontend src` зелёный, `bunx tsc --noEmit -p apps/frontend` чист, коммит.

---

### Task 1: `leaf-bundles.ts` — чистое ядро пучков (TDD)

**Files:** Create `apps/frontend/src/canvas/leaf-bundles.ts`, `apps/frontend/src/canvas/leaf-bundles.test.ts`

Интерфейсы — в спеке §4.4 (скопировать сигнатуры точно). Поведение:

- `detectLeafBundles(nodes, edges, excluded, flowAxis, gapX, gapY, minSize=3)`:
  лист = узел с ровно ОДНИМ инцидентным ребром (петли from===to игнорировать);
  группировка листьев по соседу-хабу (хаб — любой узел scope, в т.ч. с другими рёбрами);
  узлы из `excluded` не листья и не считаются; группа < minSize → не пучок;
  id пучка `__bundle__<hubId>_<i>` (i — порядковый номер по сортировке hubId);
  leaves — в порядке появления в `nodes` (стабильность); w/h/offsets — из `packBundleGrid`.
- `packBundleGrid(sizes, flowAxis, gapX, gapY)`: k колонок вдоль поперечной оси
  перебором k=1..n; ряды заполняются по порядку; ячейка (r,c): x = сумма ширин колонок
  до c + c*gapX (для flowAxis="v"; для "h" — транспонировано), выравнивание по левому/
  верхнему краю; ширина колонки = max ширин её ячеек; выбор k: min max(W,H), tie → меньший k.
- `expandBundles(bundles, pos)`: позиции листьев = pos(bundleId) + offset; пучки без
  позиции в pos — пропустить (бокс не попал в раскладку).

**Steps:**
- [ ] Тесты (писать ПЕРВЫМИ, прогнать — красные):
  1. detect: hub+3 листа → 1 пучок, листья в порядке nodes;
  2. detect: hub+2 листа → пусто (minSize);
  3. detect: один из 3 листьев в excluded → пусто (осталось 2);
  4. detect: лист с двумя рёбрами (к hub и ещё куда-то) — не лист;
  5. detect: два хаба по 3 листа → 2 пучка, id детерминированы;
  6. detect: рёбра в обе стороны (hub→leaf и leaf→hub) равнозначны;
  7. grid: 6 одинаковых 100×40, flowAxis="v", gap 24/24 → k=2 или 3 — проверить min max(W,H) и точные offsets;
  8. grid: 3 разноразмерных — ширина колонки = max, ряды по порядку;
  9. grid: n=1 → k=1, offset (0,0);
  10. grid: транспонирование для flowAxis="h" (колонки по вертикали);
  11. expand: позиции = pos + offset; отсутствующий bundleId пропущен.
- [ ] Реализация до зелёного. Без зависимостей кроме типов.
- [ ] Коммит `feat(layout): leaf-bundles — чистое ядро компактной укладки пучков (DRW-247)`.

### Task 2: пучки в контейнер-scope (`layoutContainerInternal`)

**Files:** Modify `apps/frontend/src/canvas/elk-layout.ts` (~565-655), test в `elk-layout.test.ts`

- [ ] В `layoutContainerInternal` ДО построения ELK-графа: собрать BundleNode[] из детей
  (id/w/h из effective-размеров), edges из внутренних nodeEdges (только реальные, без
  `__flow__`/`__bridge__`), excluded = pinned дети (`meta.pinned` || `meta.didrawSizePinned`);
  `flowAxis` из dir (TB/BT→"v", LR/RL→"h"); gap'ы = те же sp.nodeNode*0.62-производные,
  что идут в ELK-опции. `detectLeafBundles(...)`.
- [ ] Подмена: из ELK-графа убрать листья пучков и их рёбра; добавить узел пучка
  (id/w/h) + ребро `<hubId>__bundle-edge__<bundleId>` hub→bundle.
- [ ] После `elk().layout`: позиции супер-узлов → `expandBundles` → подставить координаты
  листьев в результат, супер-узлы из результата удалить. ВАЖНО: synthetic-рёбра пучка
  не должны утечь в writeback/последующие пассы.
- [ ] Unit (fakeEditor НЕ нужен — выделить чистый помощник, если придётся: подмена
  графа `substituteBundles(children, edges, bundles)` и обратная `restoreBundles(...)`
  тестируемы без ELK). Тесты: подмена убирает листья/добавляет супер-узел; восстановление
  возвращает листья и вычищает synthetic.
- [ ] Полный suite + typecheck + коммит `feat(layout): пучки листьев в контейнер-scope — супер-узел до ELK (DRW-247)`.

### Task 3: пучки на фрейм-уровне (`runElkLayout`) + разворот после Ф2

**Files:** Modify `apps/frontend/src/canvas/elk-layout.ts` (~1192-1590)

- [ ] Detect на loose geo фрейма (НЕ контейнеры, НЕ дети контейнеров): edges — из
  `byArrow`, оба конца loose geo того же фрейма; excluded — pinned. Хаб может быть
  контейнером? НЕТ в v1 — хаб тоже loose geo (рёбра в контейнеры не учитываются
  при подсчёте степени листа — лист с ребром в контейнер НЕ лист). Зафиксировать тестом.
- [ ] Подмена в построении компонентных графов (узлы/рёбра для partition + ELK шаг 2)
  до `splitStrays` — пучок видим как один узел и для партиции компонент.
- [ ] Разворот: ПОСЛЕ `runGlobalAlignPass` (строка ~1583) и ДО dryRun-метрик/`updateShapes`:
  `expandBundles` по позициям супер-узлов из `flat`; удалить супер-узлы из `flat`,
  добавить листья. dryRun-отчёт и updates оперируют уже листьями.
- [ ] Проверить: flip-пасс (~1408) работает по супер-узлу (бокс+ребро) — править не нужно;
  `alignLoose` Ф2 видит супер-узел как loose-бокс (двигается целиком) — править не нужно.
- [ ] Полный suite + typecheck + коммит `feat(layout): пучки листьев на фрейм-уровне — разворот после Ф2 (DRW-247)`.

### Task 4: `edge-routing-shift.ts` — чистое ядро сдвига (TDD)

**Files:** Create `apps/frontend/src/canvas/edge-routing-shift.ts`, `edge-routing-shift.test.ts`

Интерфейсы — спека §3.4 точно. Поведение:

- `pickMovableEnd`: оба конца проверить на eligibility (leaf && !pinned && degree≤2);
  из двух — меньшая степень → меньшая площадь → конец `to`. Нет → null.
- `genShiftCandidates(move, partner, parent, sameParent, gap=24)`:
  same-parent: 4 стороны партнёра (центр стороны, зазор gap) в порядке top,bottom,left,right
  + cross-align (поперечная координата центра = центр партнёра, flow-координата прежняя;
  ось — flowAxis партнёра ?? move ?? "v");
  cross-parent: cross-align + facade (сдвиг к внутренней границе родителя со стороны
  партнёра, padding 16); все кандидаты clamp в parent (если parent != null), кандидаты
  с позицией, равной текущей (±0.5) — отбрасываются; label'ы фиксированы.
- `evaluateShift(target, candidates, boxes, edges, routeFn)`: для каждого кандидата —
  боксы с подменённой позицией move-бокса → routeFn → полилинии → для целевого ребра
  `planTransfer` + `routeMetrics`; гейт спеки §3.3 (4 условия; п.4 — сумма routeScore
  по ВСЕМ рёбрам, чьи маршруты вернул routeFn). Победитель по (Σscore, длина цели,
  индекс кандидата). Использовать существующие экспортированные `planTransfer`,
  `routeScore`, `foreignCrossings`/метрики из `edge-routing-core.ts` — НЕ дублировать;
  если что-то не экспортировано — экспортировать.

**Steps:**
- [ ] Тесты первыми (красные): pickMovableEnd — pinned отсекает / degree>2 отсекает /
  контейнер отсекает / tie-break площадь / tie-break to / оба негодны → null (6);
  genShiftCandidates — same-parent 5 кандидатов с точными координатами / cross-parent
  clamp в родителя / отбрасывание no-op кандидата (3-4); evaluateShift с fake routeFn
  (возвращает заготовленные полилинии) — принятие L-кандидата / отказ: цель осталась U /
  отказ: новый overlap / отказ: суммарный score вырос / выбор лучшего из двух прошедших (5).
- [ ] Реализация до зелёного.
- [ ] Коммит `feat(layout): edge-routing-shift — чистое ядро сдвига блока (DRW-246)`.

### Task 5: shift-прогон в `runEdgeRoutingPass`

**Files:** Modify `apps/frontend/src/canvas/edge-routing.ts`, `edge-routing.test.ts`

- [ ] `EdgeRoutingReport`: + `shifted: Array<{edgeId: string; movedId: string; dx: number; dy: number}>`;
  записи `inexpressible` + `from`/`to`. Обновить оба места формирования отчёта.
- [ ] В `runEdgeRoutingPass` после `decideEdges` (и ДО writeback): если depth=0 и есть
  решения с planKind U/detour (прокинуть kind из decideEdges в decision) — построить
  degree-карту из рёбер scope, pinned-set из editor-шейпов; для каждой цели
  `pickMovableEnd` → `genShiftCandidates` (parent-бокс из RouteBox.parent) →
  `evaluateShift` с routeFn = повторная маршрутизация классов на гипотетических боксах
  (classifyEdges + routeClasses, Avoid уже загружен). Принятые сдвиги копить, обновляя
  рабочую копию боксов между целями.
- [ ] Если сдвиги есть: `editor.run` — для каждого сдвига `updateShape` x/y
  (page→parent через `getShapeParentTransform`), затем re-fit обёрток сдвинутых
  (использовать существующий механизм call-site'ов — вынести в помощник, НЕ дублировать);
  затем `return runEdgeRoutingPass(editor, inScope, byArrow, {...opts, _depth: 1})`,
  смерджив `shifted` в итоговый отчёт. `_depth` — внутреннее поле opts (не документировать
  в публичном типе — отдельный internal-параметр функции).
- [ ] Сдвигов нет → ровно прежнее поведение (existing tests не меняются, кроме формы отчёта).
- [ ] Тесты: отчёт несёт from/to/shifted; depth=1 не запускает второй shift-прогон
  (рекурсия ограничена); сдвиг отклонён гейтом → writeback как в Ф3 (fake-сценарий
  через инжект routeFn — если потребуется, выделить внутреннюю функцию планирования
  сдвигов `planShiftsForDecisions(...)` чистой и тестировать её, оркестратор — smoke).
- [ ] Полный suite + typecheck + коммит `feat(layout): сдвиг блока вместо arc-дуги в routing-пассе (DRW-246)`.

### Task 6: live-верификация (КООРДИНАТОР, не сабагент)

Чек-лист (chrome-devtools, dev :5173/:8788, space di-draw):
- [ ] Синтетика: комната drw-247-live — hub + 6 листьев (shemma_define/connect) → ⌘⇧L:
  листья сеткой ~2×3 рядом с хабом, не линия; повторный ⌘⇧L — пустой дифф (идемпотентность).
- [ ] Пин: один лист закрепить → ⌘⇧L: pinned лист не в сетке и не сдвинут.
- [ ] drw-235-probe: U-ребро (these же A3→E2): сдвиг вместо дуги (foreign=0, elbow)
  ЛИБО честный отчёт почему нет (зафиксировать в notes). `__SHEMMA_LAST_ROUTING.shifted`.
- [ ] drw-235-probe2 (CI-схема): 0 новых дефектов vs Ф3; детур e32bf99ea2 — целевой кейс.
- [ ] dl-test, a-elk-tree (locked): открыть, убедиться что НЕ тронуты (никаких ⌘⇧L там).
- [ ] Прогон обычного ⌘⇧L и force ⌘⌥⇧L на probe — оба пути живы.

### Task 7: закрытие фазы

- [ ] CHANGELOG (Unreleased): два bullet'а DRW-246/DRW-247.
- [ ] Спека: §12-аналог «Отклонения от спеки» с фактами исполнения.
- [ ] Backlog: notes + Done для DRW-246, DRW-247 (Archive — после приёмки юзера).
- [ ] Память (di-draw-project.md + MEMORY.md): статус фазы, СТОП до приёмки.
- [ ] Полный `bun run test` workspace + lint-дельта 0. Коммит docs.

## Self-review

Spec coverage: §3 → T4+T5; §4 → T1+T2+T3; §6 → тесты в T1/T4/T5 + T6. Типы согласованы
со спекой §3.4/§4.4 (единственный источник — копировать оттуда). Плейсхолдеров нет:
каждая задача несёт точное поведение и список тестов; полные сигнатуры — в спеке,
дублировать в задачах не стал умышленно (экономия, единый источник истины).
