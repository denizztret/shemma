# Agent Feedback Telemetry — Design (DRW-227)

> **Status:** draft v0.1 — 2026-06-08. Meta-инструмент, питающий DX-фиксы (родственно DRW-221/222/223).
>
> **Scope:** дизайн механизма, который по ходу работы ЛЮБОГО MCP-агента (Claude Code, OpenCode, Codex, Gemini CLI, Claude Desktop, …) автоматически собирает в файл структурированный свод его действий и проблем — для офлайн-анализа поведения агентов и точечных DX-фиксов. Это спека; реализация — отдельные follow-up подзадачи ПОСЛЕ одобрения (см. §11).

## 1. Goals

- **Детерминированный, agent/task-agnostic костяк.** На каждый осмысленный запрос агента демон пишет объективную запись (вход, результат, код ошибки, тайминг). Не зависит от кооперации или типа агента — один и тот же сценарий у разных агентов даёт структурно сравнимые записи.
- **Опциональный слой аннотаций.** Агент может приложить субъективную пометку («что хотел / где споткнулся»). Отсутствие аннотаций не ломает сбор костяка.
- **Ключевой DX-сигнал — дифф «claimed vs actual».** Из записи выводимо расхождение между заявленной агентом проблемой и фактическим серверным исходом — оно прямо показывает, где ошибки/доки не направляют.
- **Разбираемый, append-friendly файл** per (space, room), задокументированный форматом.
- **Приватность по умолчанию.** Off by default; включается явным флагом.

**Anti-goals (defer / явно вне scope):**
- Готовая аналитика, дашборды, агрегации, сравнительные отчёты по агентам.
- Любое автозаведение задач из находок (легко нагенерить мусора).
- Кросс-сессионная / кросс-комнатная корреляция за пределами одного room-файла.
- PII-редакция/scrubbing сверх size-bounding (помечено как known-consideration, §9).
- LLM-классификация проблем. Файл — сырьё для офлайн-анализа человеком/скриптом.

## 2. Архитектура (обзор)

Единый источник правды — **append-only JSONL-файл на каждую пару `(space, room)`**, который пишет **демон** (сервер). В один файл идут записи двух видов (`kind`):

- `kind:"request"` — **объективный костяк**, пишется middleware'ом на каждый подходящий `/api/*` запрос. Детерминированно, не зависит от агента.
- `kind:"annotation"` — **субъективный слой**, пишется по запросу агента (новый MCP-инструмент `shemma_feedback` → daemon-роут). Аддитивно.

Оба вида делят общий таймлайн (`ts`) и ключ `(space, room)`, опционально `clientOpId` — поэтому **корреляция и дифф «claimed vs actual» выводятся из одного файла** без внешнего стейта (§7).

```
agent (любой MCP-клиент)
   │  POST /api/domain | /api/schema/* | /api/patch | … (мутации)
   │  GET  /api/agent/context
   ▼
┌─────────────── daemon (Hono) ───────────────┐
│ app.use("/api/*", bundleResolver)           │  ← знает space/room
│ app.use("/api/*", feedbackMiddleware) ──────┼──► append {kind:"request"} ──┐
│ … route handlers …                          │                              │
│ POST /api/agent/feedback ───────────────────┼──► append {kind:"annotation"}┤
└─────────────────────────────────────────────┘                              ▼
                                              ~/.shemma/feedback/<space>__<room>.jsonl
```

Почему ключ `(space, room)`, а не session: room/space **всегда доступны на сервере** (через `installBundleResolver`), а session (`CLAUDE_SESSION_ID`) — MCP-сторонний и не всегда присутствует. Ключ по room гарантирует детерминизм; session пишется **полем** записи (когда есть), не в имя файла. `(space, room)` — глобально уникальный composite key (см. `CLAUDE.md` → Spaces registry).

## 3. Объективный костяк (`kind:"request"`)

### 3.1 Точка перехвата

Hono-middleware на `/api/*`, регистрируется в `apps/backend/src/index.ts` **только при включённом флаге** (§8), **ПОСЛЕ** `installBundleResolver` (строки ~272–294) — чтобы в `c` уже был распознан bundle (space/room). Middleware оборачивает `await next()` для замера длительности и снятия статуса:

```ts
app.use("/api/*", async (c, next) => {
  if (!feedback.enabled || !isLoggedRoute(c.req.path)) return next();
  const startedAt = nowMs();                     // тайминг через инжектируемый clock
  const reqSnapshot = await snapshotRequest(c);  // method, route, clientOpId, усечённый payload
  await next();
  // space/room берём тем же путём, что и agent-роуты: bundleForRequest(c).space
  // + resolveRoomId(c.req.query("room")) (см. routes/import-mermaid.ts, fit-text.ts).
  const { space, room } = resolveSpaceRoom(c);
  const rec = buildRequestRecord(c, reqSnapshot, startedAt); // + httpStatus/ok/errorCode/result/durationMs
  feedback.append(space, room, rec);             // best-effort, не роняет запрос
});
```

Запись — best-effort: сбой логирования (включая не-резолвящийся room) **не влияет** на ответ агенту — оборачивается try/catch (по инварианту проекта, как WS-handlers); такой запрос просто не логируется.

### 3.2 Allowlist маршрутов (решение A)

Логируются только запросы, отражающие «работу агента над схемой»:

- **Все мутации:** `/api/domain`, `/api/patch`, `/api/schema/*` (create/patch/delete/set-overlay/…), `/api/agent/layout`, `/api/agent/layout-selection`, `/api/agent/import-mermaid`, `/api/agent/fit-text`, group и пр. write-роуты.
- **Чтение контекста:** `/api/agent/context` (агент читает его, чтобы решить, что делать — важно для реконструкции «что агент знал»).
- **НЕ логируются:** `/api/health`, thumbnails, статика, `/api/state`-дампы фронтенда, viewport-биконы. Реализация держит явный allowlist (нормализованные route-паттерны), а не denylist — новые служебные роуты по умолчанию не попадают в лог.

### 3.3 Схема записи `request`

```json
{
  "ts": "2026-06-08T10:14:32.512Z",
  "kind": "request",
  "route": "/api/domain",
  "method": "POST",
  "space": "di-draw",
  "room": "adv-4255-…",
  "clientOpId": "8f3c…",
  "durationMs": 12,
  "httpStatus": 200,
  "ok": true,
  "errorCode": null,
  "payload": { "actions": [ { "kind": "define", "name": "api", "role": "service", "label": "…" } ] },
  "result": { "applied": true, "version": 7, "results": [ { "actionIndex": 0, "elementId": "api" } ] }
}
```

Поля:
- `ts` — ISO-8601 UTC, момент завершения обработки.
- `route` — **нормализованный** путь (без query; параметры пути обобщены, напр. `/api/schema/:id/measured-bounds`), чтобы записи разных прогонов группировались.
- `clientOpId` — из тела/квери, если есть (идемпотентность-ключ; основа джойна с аннотацией).
- `httpStatus`, `ok`, `errorCode` — фактический исход. `ok`/`errorCode` извлекаются из тела ответа, если оно `{ ok:false, error?, code? }` (in-band rejection при 200), иначе из HTTP-статуса. **Это — «actual» половина диффа.**
- `payload` — **size-bounded** усечённый вход (см. §3.4).
- `result` — **компактная сводка** результата: коды/идентификаторы/счётчики, **без геометрии** (никаких полных store-снапшотов; для context-роута — summary, не дамп).

### 3.4 Size-bounding (детерминированное усечение)

Чтобы файлы не пухли и запись была дешёвой:
- Сериализованный `payload`/`result` усекается до конфигурируемого лимита (напр. 4 KB на поле). При усечении — маркер `"__truncated": true` + сохранённая `length`.
- Массивы действий/результатов длиннее N — первые N + `"__omitted": k`.
- Цель — сохранить **структуру и коды** (что и с каким исходом), а не полный контент.

### 3.5 Детерминизм и agent/task-agnostic (AC#2)

- Костяк пишется **сервером**, триггерится HTTP-запросом, **не зависит** от кооперации или типа агента и от задачи.
- Два разных агента, прогоняющие один сценарий, дают **структурно идентичные** `request`-записи: те же нормализованные `route`, та же форма `payload`, те же `httpStatus`/`errorCode`. Различаются лишь содержимым лейблов и таймингом — структура сравнима напрямую.
- Единственная agent-зависимая часть — опциональные аннотации (§4), отделённые `kind`.

## 4. Слой аннотаций (`kind:"annotation"`)

### 4.1 MCP-инструмент `shemma_feedback`

Новый tool в `packages/shemma-mcp` (стандартный `CommonWriteArgs`-подобный конверт + поля ниже). Агент вызывает его, когда результат удивил или он застрял. Инструмент POST'ит на daemon-роут `POST /api/agent/feedback`, который **дописывает аннотацию в тот же room-JSONL**.

Аргументы:
- `text: string` (required) — свободная пометка: «что хотел / где споткнулся».
- `phase?: "intent" | "blocker" | "resolution"` — грубая фаза (зачем/где затык/как разрешил).
- `clientOpId?: string` — действие, к которому относится заметка (если агент его знает; обычно — `clientOpId` последнего write-вызова). Основа точного джойна.
- `room?`, `space?` — как у прочих tools (resolver).

### 4.2 Daemon-роут `POST /api/agent/feedback`

- Резолвит space/room (как прочие agent-роуты), валидирует тело, **дописывает** запись:

```json
{
  "ts": "2026-06-08T10:14:40.991Z",
  "kind": "annotation",
  "space": "di-draw",
  "room": "adv-4255-…",
  "clientOpId": "8f3c…",
  "phase": "blocker",
  "text": "хотел удалить v2-фрейм через shemma_delete, получил unknown-ref — думал, delete не видит v2",
  "agent": "claude-code",
  "sessionId": "CLAUDE_SESSION_ID-если-есть"
}
```

- `agent` — self-reported идентификатор клиента (из аргумента или MCP-метаданных, если доступны); чисто информативный.
- При **выключенном** флаге роут — no-op с явным ответом (`{ ok:true, recorded:false, reason:"feedback disabled" }`), чтобы вызов агента не падал.
- **Аддитивность:** костяк работает и без единого вызова `shemma_feedback`. Отсутствие аннотаций не ломает сбор (AC#3).

### 4.3 Нудж агенту

- В description инструмента и в `packages/shemma-mcp/src/workflow/draw-architecture.md` — короткая строка: «если результат tool'а удивил или ты застрял — зафиксируй `shemma_feedback` (что хотел / где затык); это помогает чинить DX». Без давления: инструмент опционален.

## 5. Дифф «claimed vs actual» (AC#4)

Так как обе записи в одном файле делят `space/room/ts` и опц. `clientOpId`, дифф выводится офлайн из room-JSONL:

1. **Точный джойн (есть `clientOpId`):** аннотация → `request` с тем же `clientOpId`. Сравнить **claim** (текст/`phase` аннотации) с **actual** (`ok`/`errorCode`/`httpStatus`/`result` запроса).
   - Пример: annotation `"delete не видит v2"` ↔ request `{route:"/api/domain", ok:false, errorCode:"unknown-ref"}` → агент мисдиагностировал (ошибка не направила к `shemma_delete_schema`) → DX-сигнал, ровно как в DRW-224.
2. **Приближённый джойн (нет `clientOpId`):** аннотация → ближайшая предыдущая `request`-запись в том же room-таймлайне (по `ts`).

Спека документирует сам джойн. **Готовый аналитический инструмент — вне scope** (follow-up §11.3 намечает крошечный read-only `shemma feedback --diff`, не более).

## 6. Формат и расположение файла (AC#5)

- **Формат:** JSONL — один JSON-объект на строку. Append-only: краш-безопасно, без read-modify-write, стримится, легко парсится (`jq`, любой line-reader).
- **Расположение:** `~/.shemma/feedback/<space>__<room>.jsonl`. Каталог `~/.shemma/feedback/` создаётся лениво при первой записи (в духе `~/.shemma/run/`). `<space>__<room>` — нормализованный composite key (sanitized под имя файла).
- **Ротация:** size-based. При превышении порога (напр. 16 MB) текущий файл переименовывается в `<…>.1.jsonl` (сдвиг существующих), запись продолжается в свежий. Минимум в костяке; продвинутая retention — вне scope.
- **Конкурентность:** запись через единый сериализованный аппендер на процесс (демон — singleton на машину, см. `CLAUDE.md`), поэтому гонок по файлу нет.

## 7. Корреляция без внешнего стейта

Файл самодостаточен: room-таймлайн + `clientOpId` дают и реконструкцию «что агент делал», и дифф (§5). Никакой БД/индекса — сырой JSONL — намеренный выбор (KISS, append-friendly, переносимо).

## 8. Конфигурация / opt-in (приватность по умолчанию)

- **Off by default.** Включается:
  - env `SHEMMA_FEEDBACK=1` (для разовых сессий анализа), и/или
  - поле в конфиге (`~/.config/shemma/spaces.json` либо общий конфиг демона), напр. `{ "feedback": { "enabled": true, "maxFieldBytes": 4096, "maxFileBytes": 16777216 } }`.
- При выключенном флаге: middleware не регистрируется (нулевой оверхед), `/api/agent/feedback` — явный no-op (§4.2).
- Флаг читается на старте демона; смена — через рестарт демона (консистентно с прочими runtime-настройками).

## 9. Приватность и known-considerations

- Файл содержит **реальный контент схем** (лейблы/тексты узлов из payload'ов). Поэтому off by default и явный opt-in.
- Size-bounding ограничивает объём, но **не редактирует** PII. Полноценный scrubbing/redaction — **вне scope** этой задачи (отмечено как осознанный долг; если понадобится — отдельный follow-up).
- Файлы лежат локально под `~/.shemma/feedback/`, не публикуются и не уходят по сети.

## 10. Затрагиваемые модули (для последующего плана)

- `apps/backend/src/index.ts` — регистрация feedback-middleware (после bundleResolver) + роут `/api/agent/feedback`.
- `apps/backend/src/feedback/` (новый) — `writer.ts` (JSONL-аппендер + ротация + size-bounding), `record.ts` (схемы/билдеры записей), `routes.ts` (allowlist + нормализация route).
- `apps/backend/src/config.ts` — чтение флага/лимитов.
- `packages/shemma-mcp` — `schemas.ts::FeedbackArgs`, новый tool `shemma_feedback`, `@shemma/client::feedback()`.
- `packages/shemma-mcp/src/workflow/draw-architecture.md` — нудж.
- Доки формата файла (где-то под `docs/` или README-секция).

Не противоречит контракту `feedback-no-auto-layout-on-ai-edit` (телеметрия пассивна, ничего на доске не меняет).

## 11. Follow-up подзадачи (заводятся ПОСЛЕ одобрения спеки) (AC#6)

1. **Костяк телеметрии.** Middleware + allowlist + нормализация route + JSONL-writer + size-bounding + size-ротация + флаг/конфиг. Тесты: middleware пишет `request` на мутацию/контекст, пропускает health/thumbnails; усечение; ротация; флаг off → нет файла.
2. **Слой аннотаций.** Роут `POST /api/agent/feedback` + MCP-tool `shemma_feedback` + `@shemma/client::feedback()` + нудж в `draw-architecture.md`. Тесты: аннотация дописывается в тот же файл; флаг off → no-op без падения; отсутствие аннотаций не ломает костяк.
3. **Формат + лёгкий ридер.** Документация формата файла + опциональный read-only `shemma feedback --diff <room>` (джойн §5, печать расхождений). Без аналитики/агрегаций.

**Явно вне рамок DRW-227 и follow-up'ов выше:** развитая аналитика, дашборды, сравнительные отчёты, автозаведение задач из находок (см. Anti-goals §1).

## 12. Соответствие Acceptance Criteria

- **AC#1** (дизайн-спека: цель, что захватывается, схема, формат/расположение, точки перехвата, граница объективное/субъективное) — §1–§9.
- **AC#2** (детерминизм + agent/task-agnostic) — §3.5 (серверный костяк), §2 (ключ по room).
- **AC#3** (опциональные аннотации; их отсутствие не ломает сбор) — §4 (аддитивный слой, §4.2 no-op при off).
- **AC#4** (дифф claimed-vs-actual) — §5.
- **AC#5** (разбираемый, append-friendly формат per session/room, задокументирован) — §6 (JSONL per room).
- **AC#6** (намечены follow-up'ы; аналитика/автозадачи вынесены) — §11.

## 13. Формат файла + ридер (DRW-227.03, реализовано)

**Файл:** `~/.shemma/feedback/<space>__<room>.jsonl` (override через `SHEMMA_FEEDBACK_DIR` — его уважают и writer демона, и ридер CLI). Append-only JSONL, одна запись на строку, два `kind`:

- `request` — `{ ts, kind:"request", route, method, space, room, clientOpId, durationMs, httpStatus, ok, errorCode, payload, result }` (§3.3). Пишется костяком на каждую агентскую мутацию + `/api/agent/context`.
- `annotation` — `{ ts, kind:"annotation", space, room, clientOpId, phase, text, agent, sessionId }` (§4.2). Пишется по вызову `shemma_feedback`.

**Ридер:** `shemma feedback --diff <room> [--space <id>]` — read-only. Для каждой аннотации находит её `request` (точно по `clientOpId`, иначе ближайший предыдущий по `ts`) и печатает пару «claim (текст/phase аннотации) → actual (route/ok/errorCode запроса)». Помечает `⚠ possible misdiagnosis`, когда аннотация-`blocker` ссылается на запрос, который на самом деле `ok:true` (агент решил, что упало, а сервер ответил успехом). `--json` отдаёт структурированные `entries`. Без `--space` — скан `*__<room>.jsonl` (уникальный → берётся; несколько → просит `--space`). **Строго ридер: никакой аналитики/агрегаций/дашбордов/автозадач.**
