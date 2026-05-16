## Что даёт каждая задача — функциональный взгляд

Расскажу через призму **что меняется для пользователя/AI** после фикса, без технических деталей реализации (они уже в backlog).

---

### 🔴 Критические — без них фундаментальные сценарии сломаны

#### **D3 — pin discipline в layout**

**Сейчас:** ты говоришь AI «нарисуй схему API → DB → Worker». AI делает 3 `define` + 2 `connect` + `layout layered-lr`. На канвасе ты видишь три **наложенных в (10,10) квадрата** — всё в одной точке. AI пишет тебе «готово» — а схемы нет.

**После фикса:** AI'шная композиция узлов правильно раскладывается ELK'ом. Узлы разнесены по lanes. Видна реальная схема. Это основной AI use-case инструмента — сейчас он сломан.

**Влияние:** блокирует ВЕСЬ AI workflow с >1 узлом и group action.

---

#### **D4 — group bbox = null**

**Сейчас:** ты говоришь AI «сгруппируй worker и queue в boundary "async-side"». AI делает `group`. На канвасе — **никакого визуального контейнера** (ни рамки, ни fill). Просто два болтающихся узла. Группировка существует только в backend state, никак не видна.

**После фикса:** видна рамка boundary вокруг детей, заливка пресета (orange diagonal stripes для boundary, синий fill для network и т.д.). Можно сразу понять «вот эти узлы — async-side».

**Влияние:** без этого `group` action бесполезен визуально — а это одна из 6 базовых domain actions.

---

#### **D5 — children координаты absolute/relative**

**Сейчас:** даже когда D4 починят (bbox появится), child-узлы могут быть в (10,10) absolute, а group в (180,160). Получится: контейнер где-то справа внизу, а его «дети» физически в левом верхнем углу. Layout рассинхрон.

**После фикса:** child всегда внутри своего parent group. Single source of truth для координат (рекомендую absolute). Решение фиксируется ADR'ом, чтобы будущие фазы не блуждали.

**Влияние:** парная с D4 — починить нужно вместе, иначе boundary всё равно выглядит сломано.

---

#### **D6 — runaway 422 loop**

**Сейчас:** при любом state mismatch (frontend baseline ≠ server state) frontend начинает спамить **27000+ rejected patches в минуту**. Это:
- забивает CPU и сеть,
- забивает console — debugging невозможен,
- спамит сервер (мог бы вообще завалить production daemon на медленной машине).

В нормальных user-сценариях триггерится не часто, но **при reconnect / reload в плохо synced state** — да. Это бомба замедленного действия.

**После фикса:** одна неуспешная попытка → ErrorBanner → клиент честно говорит «sync rejected, попробуйте reload» вместо тихого DDoS на собственный backend.

**Влияние:** stability. Особенно важно если когда-то перейдём на push (CI и т.п.) — там 27000 запросов/мин = реальная проблема.

---

#### **D10 + D11 — multi-room через CLI/AI невозможен**

**Сейчас:** комнаты (rooms) — основная организация изоляции (per-проект, per-задача, per-AI-session). Frontend умеет переключаться через `?room=foo`. CLI умеет `rooms list/import/archive/restore/export`. Но **AI не может писать в комнату кроме `default`** — все `define/connect/group/note/layout/delete/apply` молча пишут в default независимо от `--room` или body.room.

То есть multi-room существует на бумаге, но AI заперт в одной комнате.

**После фикса:** AI может работать в разных комнатах параллельно (например, одна сессия — fronetend-арх, вторая — backend-арх). Skill cheat-sheet начнёт реально использовать room name из контекста. Можно делать `ai start --room <session-id>` и история одной сессии не загрязняет другую.

**Влияние:** unblock'ает реальный multi-session workflow, который заявлен в дизайне с Phase 1, но не работал на практике.

---

### 🟡 Major — не блокеры, но качество жизни

#### **D7 — `markHistoryStoppingPoint` undocumented**

**Сейчас:** если ты пишешь mod к frontend (или тест), и используешь editor API без `markHistoryStoppingPoint` — твои изменения **тихо не доходят до backend**. Никаких ошибок, ничего. Я сам наткнулся на это во время smoke — потерял 10 минут.

**После фикса:** либо документация в комментариях/SKILL, либо listener срабатывает на любой store change.

**Влияние:** developer experience / testability. Для frontend tests (W3) это критично — без понимания этого тесты будут давать false positives.

---

#### **D8 — `/api/version` polling 200 req/sec**

**Сейчас:** браузер делает GET `/api/version` примерно каждые 5ms. Это значит **17000 запросов за минуту работы**. Видно в Network DevTools. CPU greenhouse-эффект, батарея ноута, log spam на backend.

**После фикса:** polling раз в 10-30 сек, или вообще через WS push при release-обновлении. CPU и сеть сразу падают на 99%.

**Влияние:** перформанс и UX (на слабых машинах frontend может тормозить из-за этого одного).

---

#### **W3 (test debt) — frontend tests для `to-patch.ts`**

**Сейчас:** B1 (user-arrows roundtrip) работает (T56 PASS), но **проверяется только manual smoke**. Любое будущее изменение `to-patch.ts` (например, я делаю D7 фикс) может тихо сломать B1, и я узнаю об этом только когда ты попробуешь рисовать стрелку.

**После фикса:** unit-тесты на arrow detection → регрессии ловятся CI'ем (если он будет), и я могу безопасно рефакторить.

**Влияние:** мета-задача. Не даёт нового user-visible поведения, но защищает существующее от регрессий.

---

### 🟢 Minor — косметика

| ID   | Что                                       | Чем поможет                                                 |
| ---- | ----------------------------------------- | ----------------------------------------------------------- |
| D1   | UI badge `v0.3.0` → `0.3.0`               | Соответствие новой numeric-tag policy.                      |
| D2   | favicon 404                               | Чистая console; lighthouse-чекеры зелёные.                  |
| B-F1 | `pushOpLog` helper                        | Меньше boilerplate, реже забываешь cap.                     |
| B-F2 | убрать legacy hello frame                 | Чище WS handshake.                                          |
| B-F3 | унифицировать `findGroupByName`           | Граничные кейсы (одинаковое имя/label) станут предсказуемы. |
| B-F4 | ErrorBanner MAX=3                         | Соответствие spec.                                          |
| B-F5 | schema-validation opLog                   | Защита от corrupt envelope (manual edit etc).               |
| B-F6 | pause patches во время truncated-recovery | Меньше визуальных flicker при reconnect.                    |
| B-F7 | sync spec по opLogMaxSize                 | Документация не врёт.                                       |
| B-F8 | omit `dashed:false` в add edge            | Чище payload.                                               |
| B-F9 | endpoint-move для `update edge`           | Cross-client sync при перетаскивании стрелки.               |

---

## Группировка для веток (что разумно делать вместе)

**`fix/cli-room-flag` (D10 + D11)** — одна ветка. Эффект: multi-room workflows работают. **Effort: S (1 день).** Самый дешёвый из критов — рекомендую начать с этого.

**`fix/layout-pin-discipline` (D3 + D4 + D5)** — одна ветка. Связанная тройка про pin/group/coords. **Effort: M (2-3 дня).** Самый ценный для AI use-case, но сложнее всего — затрагивает spec'у и требует ADR.

**`fix/no-retry-422` (D6)** — одна ветка. **Effort: S-M.** Нужно сначала точно понять trigger conditions (репродукция).

**`chore/dev-quality` (D1 + D2 + D8 + D7)** — одна ветка для мелкого DX/cosmetic. **Effort: S.**

**`test/frontend-suite` (W3)** — отдельная мета-ветка для test infra. **Effort: M.** Не блокирует ничего, но помогает делать дальнейшие фиксы безопасно.

---

## Мой совет по последовательности

1. **`fix/cli-room-flag`** — first, дешёвый, разблокирует multi-session тестирование.
2. **`fix/layout-pin-discipline`** — самое ценное для основного use-case.
3. **`fix/no-retry-422`** — превентивно, чтобы не страдать при будущих rebase'ах.
4. **`test/frontend-suite`** — заложить базу для будущих fix'ов.
5. Косметика — попутно или одной wave-веткой.
