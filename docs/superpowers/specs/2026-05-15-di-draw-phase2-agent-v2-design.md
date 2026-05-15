# di.draw Phase 2.1 — Agent v2: domain-first model + layout intelligence

> **Status:** design (v2.1.1, 2026-05-15) — pending user review
> **Predecessor:** `2026-05-14-di-draw-design.md` v3.7 (Phase 1 MVP, shipped)
> **Revision history:**
>   - v1 — palette-based actions;
>   - v2 — pivot to domain-first («роли важнее цвета»);
>   - v2.1 — full ELK + extensibility map;
>   - v2.1.1 — после review закрыты 7 системных gap'ов: shared `@didraw/domain` пакет для role→preset, унификация на `mode` (drop `direction`), transactions only для actions + layout best-effort, pin inference в `/api/patch source:user`, container model canonical через `Group.children`, v1 edge routing — ports/anchors only, UI overlay reserve вынесен из layout в frontend camera.
> **Roadmap context:** one of six Phase 2 sub-projects (см. §0)

## 0. Phase 2 roadmap (контекст)

MVP закрыт (52 коммита на main, single-binary verified). Двигаемся к daily-use release. Сообщение пользователя 2026-05-15 покрыло шесть направлений, не помещающихся в одну спеку. Декомпозиция:

| ID | Sub-project | Зависимости | Spec status |
|----|---|---|---|
| **2.0** | Persistence hardening — session-isolation fix, rooms discovery, **room export/import to JSON file** (backup + cross-folder transfer), skill startup awareness | — | [`2026-05-15-di-draw-phase2-0-persistence-design.md`](./2026-05-15-di-draw-phase2-0-persistence-design.md) (~5-7 tasks) |
| **2.1** | Agent v2 — domain-first model (roles, not geometry), full ELK layout intelligence (compound, ports, orthogonal, bendpoints, pin), single API surface, extensibility map | requires 2.0 | **этот документ** |
| **2.2** | Roundtrip & sync hardening (user-arrows → backend, ack/replay, no-silent-fail) | parallel/after 2.1 | TBD |
| **2.3** | MCP adapter v1 (read + domain actions, не сырой patch) | requires 2.1 | TBD (replaces `docs/handoff/mcp-launch-brief.md`) |
| **2.4** | Import — Mermaid (already partial) + SVG + D2 + Miro JSON + (опционально) PNG/SVG-image → roles via heuristics. Layout пере-применяется на доменной модели после импорта. | requires 2.1 | TBD |
| **2.5** | Export — Mermaid + native tldraw SVG/PNG + Miro REST API + Figma REST API + PlantUML (если уйдёт по simplicity). Все форматы через registry, добавление формата = один файл. | requires 2.4 | TBD |
| **2.6** | Multi-LLM hardening (Claude / Codex / corporate) — docs + verification | docs-only, after 2.1-2.3 | TBD |
| 3.x | Custom tldraw shapes per role, drawing-as-first-class, Cola/fCoSE «untangle graph» команда, multi-user shared rooms | deferred | — |

Этот документ покрывает только **2.1**. Каждый следующий sub-project получит свою спеку и план.

---

## 1. Цели и неуспех

### 1.1. Главная идея

di.draw — инструмент для **визуализации архитектурных решений из диалога**. Пользователь объясняет архитектуру (или AI её предлагает), а canvas строит **красивую и понятную** диаграмму — такую, что не хочется перерисовывать вручную.

Это значит: агент работает в терминах **домена** (есть сервис auth, есть база users-db, между ними поток данных), а не геометрии (rect at 200,300 with width 120). Визуальное оформление — детерминированная функция от роли и связи, не свободное творчество LLM.

### 1.2. Что должно стать правдой после Phase 2.1

1. **Domain model — primary API.** Агент пишет в canvas через `define-element`/`connect`/`group`/`note`/`layout`/`delete` с обязательными `role` и `name`, а не через сырой PatchOp. Single API surface — нет двойного пути «action + patch для агента».
2. **Visual is a function of role.** Каждой роли (`actor`, `service`, `datastore`, `queue`, `network`, `boundary`, `external`, `note`) соответствует tldraw-preset (shape kind + base style). Frontend `role-render.ts` — single source of truth. AI не выбирает цвет/форму, не сочиняет.
3. **Layout intelligence — first-class.** При каждом mutation auto-recompute layout: новые элементы встают в место, существующие не дёргаются без нужды. Group-aware (`network`/`boundary` держат детей внутри), mode-driven (`layered-lr` / `layered-tb` / `tree` / `pack` / `force` — выбор per-batch или per-group). После любого batch агенту не нужно отдельной командой «layout».
4. **Token-cheap context.** AI читает компактное view-aware представление вместо full snapshot. Целевой объём для 100-элементного canvas ≤ 8KB JSON (≤ ~2K tokens) против 20-40KB сегодня. Context включает domain summary (counts by role, top-level groups, recent ops в человекочитаемом виде), не raw nodes/edges.
5. **PatchOp остаётся** как **транспорт между frontend и backend** для пользовательских правок (user перетащил, перекрасил вручную). Агент через patch не ходит — этот путь невидим для AI. Это снимает риск двух конкурирующих агентских API.
6. **Idempotency & deterministic ids.** Безопасный retry. Имена элементов читабельны (`auth`, `users-db`), не uuid.

### 1.3. Что НЕ цель этой фазы

- **Цветовая палитра / `tone`/`accent` vocabulary.** Точечная покраска — native tldraw. Если пользователь хочет другой цвет — он перекрасит сам, и frontend zachoваnет override (см. §6).
- **Custom tldraw shapes под каждую роль.** В v1 — geo + style preset. Custom shape utils — backlog (если по результатам daily-use какая-то роль реально требует уникального визуала, например цилиндр для datastore).
- **Push-канал user-prompts → AI (B2).** Phase 2.3 (MCP subscribe).
- **User-нарисованные arrows → backend (B1).** Phase 2.2.
- **Inline NL→action парсер на backend (L3).** Парсинг диалога — задача LLM-агента, не backend. Backend принимает только typed actions.
- **Import / Export.** Phase 2.4 / 2.5.
- **Drawing (freeform), multi-user.** Phase 3.

---

## 2. Архитектура

Минимум слоёв: один domain API (`/api/domain`), один **shared role→preset module** (используется backend и frontend через workspace package), один layout engine.

```
packages/didraw-domain/src/         # NEW: shared between backend и frontend
  roles.ts            # Role enum + leaf vs container classification
  connection-kinds.ts # ConnectionKind enum
  role-preset.ts      # SINGLE source of truth: role → {tldraw shape preset, defaults}
  layout-modes.ts     # LayoutMode enum + mode→elkOptions
  validation.ts       # name regex, role transition rules (shared)
  index.ts            # public re-exports

apps/backend/src/
  domain/
    types.ts          # Element, Connection, GroupRef (внутренние shape для backend state)
    validate.ts       # synchronous validators (refs exist, role known, name unique)
    compile.ts        # DomainAction[] → PatchOp[]   (pure, deterministic; импортирует из @didraw/domain)
    layout.ts         # group-aware ELK call + jitter-min + pin support
    layout-postprocess.ts  # snap-to-grid + min-spacing + preserve-order
    context.ts        # buildAgentContext — domain-summary view, не raw shapes
    viewport.ts       # last-known viewport per room (ephemeral)
  routes/
    domain.ts         # POST /api/domain   (batch actions, dry-run, auto-layout)
    context.ts        # GET  /api/agent/context
    viewport.ts       # POST /api/viewport

packages/didraw-client/src/
  domain.ts           # CanvasClient.define / connect / group / note / layout / delete

packages/didraw-cli/src/
  domain.ts           # `didraw define / connect / group / note / layout / delete / apply / context`

apps/frontend/src/
  canvas/
    role-render.ts    # tldraw rendering — импортирует preset table из @didraw/domain
    role-render.test.ts
  transport/
    viewport.ts       # debounced camera→backend report
```

**Sigh-of-relief property:** PatchOp полностью невидим в агентском API. CLI/MCP/skill не упоминают `patch`. `/api/patch` остаётся как frontend↔backend transport — единый канал для user-edits и для compiled-output domain layer'а.

**Single source of truth разрешение:** `packages/didraw-domain` импортируется и backend (для compile.ts ↦ применять preset как defaults в `add node` ops), и frontend (для render.ts ↦ применять preset поверх state при рендере). Это снимает конфликт v2: «backend хранит kind/style» теперь честно — он хранит preset-defaults через тот же модуль, что использует frontend, не дубликат таблицы.

### 2.1. Почему domain layer заменяет patch для агента, а не «поверх»

PatchOp — естественный output frontend'а: tldraw editor выдаёт diff, мы шлём `/api/patch`. Этот путь не трогаем — backwards-compatible.

DomainAction — это **единственный** канал для агента. На backend он компилируется в PatchOp (через `domain/compile.ts`) и проходит через тот же `applyPatch`/opLog/bus pipeline. Никакого второго storage, никакого parallel state — компилятор и есть «склейка» между уровнями.

Когда через 6 месяцев захочется поменять визуальное оформление роли (например, `datastore` начнёт рендериться cylinder shape) — меняется **только** `role-render.ts`. Когда захочется добавить роль (`cache`, `lambda`, `cdn`) — добавляется одна строка в типах + одна в renderer. Никакого rolling-refactor по слоям, потому что слой один.

### 2.2. UX контракт для пользовательских правок

Если пользователь руками меняет визуал (перекрасил блок, передвинул) — frontend пишет PatchOp в backend как раньше. Backend хранит этот override в `style`/`meta` элемента. При следующем agent action на тот же элемент `compile.ts` уважает override: если у элемента уже есть user-set цвет — base preset из роли не перезаписывается. Это **single rule** — «user override beats role default» — и она живёт в одном месте (compile.ts merge logic).

---

## 3. Domain model + actions v1

### 3.1. Roles (extensible enum)

```ts
type Role =
  | "actor"      // user, customer, external person
  | "service"    // app, API, microservice, function, daemon
  | "datastore"  // DB, S3, cache, file storage
  | "queue"      // message broker, event bus, stream
  | "network"    // VPC, subnet, perimeter — *container* role (groups children)
  | "boundary"   // logical/team/security boundary — also container role
  | "external"   // 3rd-party service, external API
  | "note";      // annotation, ADR pointer, decision record
```

Roles делятся на **leaf** (`actor`/`service`/`datastore`/`queue`/`external`/`note`) и **container** (`network`/`boundary`).

**Canonical container model**: parent-child связь хранится **только** в `Group.children: ElementId[]` — это и есть «положи auth внутрь vpc-prod». В типах элементов **нет** `parent` поля. Никаких дублирующих указателей и проблемы синхронизации.

- В backend `apps/backend/src/types.ts` уже есть `Group { id, children, ... }` (см. §3 текущей model spec v3.7). Phase 2.1 переиспользует.
- При компиляции `group` action — `compile.ts` создаёт/обновляет соответствующую `Group` запись через PatchOp `add/update group`, никаких параллельных правок child-нод.
- Frontend и context-API могут производить **derived** «parent» в response для UX (например `ElementCompact.parent` в context view §4.2) — но это компьютация на чтение, не stored field.
- Перемещение элемента между containers = batch из двух `update group {id, set: {children}}` ops (одно убрать, одно добавить). Можно обернуть в helper-action в backlog, в v1 — explicit.

Расширение: добавить роль = одна строка в `Role` union + одна в `role-preset.ts` table. Никаких rolling-changes.

### 3.2. Connection kinds

```ts
type ConnectionKind = "sync" | "async" | "data" | "dep";
// sync : solid arrow, default label "calls"          (HTTP, RPC)
// async: dashed arrow, default label "publishes"     (queue, event)
// data : solid arrow, double-headed allowed          (DB read/write)
// dep  : dotted arrow, no label                       ("depends on")
```

Визуальное оформление коннектов — детерминированно по `kind`. Агент выбирает **kind** (передаёт замысел), а не dashed/solid (геометрию).

### 3.3. Common envelope

```ts
type DomainRequest = {
  actions: DomainAction[];
  clientOpId?: string;        // idempotency key
  dryRun?: boolean;
  layoutHint?: LayoutHint | null;    // null = skip auto-layout; default = {mode:"layered-lr", scope:"affected"}
};

type LayoutHint = {
  mode?: LayoutMode;          // see §3.6.1; default "layered-lr"
  scope?: "all" | "affected" | ElementId;
  spacing?: "compact" | "normal" | "loose";  // default "normal"
};
// LayoutMode comes from @didraw/domain shared package; no `direction` field — направление выводится из mode.

type DomainResponse =
  | { ok: true; version: number; idempotent?: true;
      results: ActionResult[];
      layout?: { applied: boolean; affected: ElementId[] }; }
  | { ok: false; errors: ActionError[]; };

type ActionResult = {
  actionIndex: number;
  elementId?: ElementId;     // для define/group — итоговый id
  generatedOps?: PatchOp[];  // только при dryRun
};

type ActionError = {
  actionIndex: number;
  field?: string;
  code: "unknown-role" | "unknown-ref" | "name-conflict" | "role-conflict"
      | "cascade-confirm-required" | "invalid-shape" | "compile-error";
  message: string;
  affected?: ElementId[];   // для cascade-confirm-required
};
```

**Transaction model**:
- **Domain mutations** (define/connect/group/note/delete) — атомарны. Либо все actions из batch применяются, либо ни одной (на validation/compile error — 422, state untouched).
- **Layout** — **best-effort**, не часть транзакции. Если ELK упал/timeout — domain mutations всё равно применяются, response содержит `layout: {applied: false, reason: "elk-timeout"}` или подобное. Диаграмма выживает даже когда layout engine сбоит; элементы получают `meta.position` со старыми/неинициализированными координатами, пользователь может сдвинуть руками.

Это честнее, чем «всё или ничего»: domain integrity сохраняется, а layout — улучшение поверх.

### 3.4. The 6 actions

| Kind | Args | Notes |
|---|---|---|
| `define` | `{role: Role; name: string; label?: string; in?: ElementId; meta?: object}` | `name` — human-readable id (`auth`, `users-db`). Unique per room. `in` — container parent. `label` default = `name`. **Upsert semantics**: повторный define c тем же `name` обновляет `label`/`meta`/`in`; попытка сменить `role` → 422 `role-conflict`. |
| `connect` | `{from: ElementId; to: ElementId; kind?: ConnectionKind; label?: string; meta?: object}` | Default `kind` = `sync`. `from`/`to` ссылаются на existing element by name. |
| `group` | `{ids: ElementId[]; as: "network"\|"boundary"; name: string; label?: string}` | Объединить existing элементы в container. Children получают `parent`. |
| `note` | `{about?: ElementId; text: string; name?: string}` | Annotation. Если `about` задан — нота визуально привязана (arrow binding). |
| `layout` | `{mode?: LayoutMode; scope?: "all"\|ElementId; spacing?: "compact"\|"normal"\|"loose"}` | Explicit re-layout. Обычно не нужен — auto-layout по умолчанию. `direction` не существует — направление выводится из mode. |
| `delete` | `{id: ElementId} \| {ids: ElementId[]} \| {ids:[...], cascade: true}` | Cascade-aware: удаление container с детьми требует `cascade:true`, иначе 422 `cascade-confirm-required` с `affected` (для UX «вы уверены?»). |

**Что исчезло из v1:**
- `restyle` — точечная покраска native в tldraw, агент не нужен.
- `move` — auto-layout делает позиционирование. Для редкого pin-position — через `meta.position`.
- `relabel` — слилось с `define` (upsert).
- `propose` — preview ушёл в `dryRun:true` (то же намерение, без отдельного state).

6 actions, каждая — domain-level intent.

### 3.5. Element identity

Имена — readable, выбираются агентом или пользователем (`auth`, `users-db`, `vpc-prod`). Backend хранит mapping `name → internal shape id`. `name` per room unique; underscores/hyphens разрешены, spaces — нет.

Tldraw shape id формируется как `shape:e_${slug(name)}` (детерминированно — переоткрытие сессии воссоздаст те же ids, не сломаются stored references).

### 3.6. Auto-layout policy

ELK — primary engine (он уже подключен в `apps/backend/src/layout-engine.ts`, но сейчас используется в ~5% возможностей: только плоский graph + node coords, никаких compound, ports, edge routing, bendpoints, direction, pin). Phase 2.1 разворачивает его на полную.

#### 3.6.1. Layout modes (вместо плоского `algorithm`)

`LayoutMode` — enum, явно семантичный. `LayoutHint.mode` заменяет старый `direction`:

```ts
type LayoutMode =
  | "layered-lr"   // ELK layered, direction RIGHT — для архитектуры/system diagrams (default)
  | "layered-tb"   // ELK layered, direction DOWN — для pipeline/flow
  | "tree"         // ELK mrtree — для иерархий с одним корнем
  | "pack"         // ELK rectpacking — disconnected components packed neatly
  | "force";       // ELK force — fallback для messy graphs

type LayoutHint = {
  mode?: LayoutMode;        // default "layered-lr"
  scope?: "all" | "affected" | ElementId;
  spacing?: "compact" | "normal" | "loose";  // → ELK spacing.nodeNode/.edgeNode/.componentComponent
};
```

Старый `algorithm: "dagre"` (misleading — реально elk-force) **переименовывается**: API меняется на `mode`, value `force` остаётся как honest fallback. Backwards-compat: один tick — старый `algorithm` параметр принимается и маппится в `mode` с deprecation warning в response.

Расширение: добавить mode — одна строка в enum + один case в `mode-to-elk-options.ts`. Cola/fCoSE/Dagre-настоящий — будущая фаза (см. §14 Extensibility), regisry-pattern engine.

#### 3.6.2. ELK feature usage — full

| ELK feature | Где используется в di.draw | Status today | После Phase 2.1 |
|---|---|---|---|
| `elk.algorithm` | layout-engine | flat string | mode-driven через `mode-to-elk-options` |
| `elk.direction` | layered modes | not used | `RIGHT`/`DOWN` per mode |
| `elk.edgeRouting` | архитектурные схемы | not used | `ORTHOGONAL` для layered modes (rectangular bendpoints — естественно для архитектурных диаграмм) |
| `elk.spacing.*` | spacing levels | default | компактный/нормальный/loose preset |
| `compound nodes` | network/boundary containers | not used | **критично**: containers становятся ELK compound nodes с children, ELK сам располагает внутренности |
| `ports` | edge anchors | not used | для service↔service connections — северный/южный/восточный/западный port (tldraw `normalizedAnchor` пересчитывается из ELK port-side) |
| `bendpoints` | tldraw arrow waypoints | not used | ELK возвращает sections с bend points → tldraw arrow получает waypoints (через property update; см. §3.6.5) |
| `elk.fixed = true` | pin support | not used | элементы с `meta.position` и `meta.pinned=true` получают fixed constraint |
| partial layout | affected scope | not used | only `affected` subgraph отправляется в ELK; неаффектнутые ноды передаются как fixed (pinned) |

#### 3.6.3. Scope policy

- `scope: "affected"` (default) — backend строит affected set = `defined + connected_to_defined + groups_containing_defined`. Всё остальное в `state` передаётся в ELK как pinned (fixed). Это даёт jitter-min: пользовательская часть диаграммы не двигается.
- `scope: "all"` — full recompute. По явному запросу. Применяется, когда пользователь сам сказал «переставь всё».
- `scope: "<groupId>"` — re-layout только внутри указанного container'а; всё снаружи — pinned.

#### 3.6.4. Pin / user overrides

Элементы имеют:
- `meta.position: {x,y}` — последняя позиция (всегда).
- `meta.pinned: boolean` — установлено `true` когда **пользователь явно** перетащил/закрепил.

ELK получает pinned элементы с `elk.fixed = true`. Auto-layout их не двигает.

Не-pinned элементы могут получить новую позицию при relayout. После того как ELK вернул координаты — backend пишет их обратно в `meta.position` (но не флипает `pinned` в `true`). Это даёт: «пока пользователь не вмешался — layout рулит; как только вмешался — pin остаётся навсегда».

Reset pin: action `define {name:"auth", meta:{pinned: false}}` (опциональная low-priority feature, backlog если случай возникнет).

#### 3.6.5. Edge routing → tldraw (v1 scope: ports + anchors only)

tldraw 5.x arrow shape не имеет first-class multi-bendpoint API. Поэтому **v1 не делает ORTHOGONAL multi-bendpoint routing** — это backlog.

Что **попадает в v1**:
- **Ports**: ELK для каждой ноды вычисляет `port-side` (N/S/E/W) для каждого incident edge. Frontend пересчитывает `normalizedAnchor` из port-side ({0.5, 0}, {0.5, 1}, {1, 0.5}, {0, 0.5}). Это уже улучшает визуал: arrows выходят из «правильной» грани, не из центра.
- **Better anchors**: `isPrecise: true` плюс точный port-side. Tldraw нативно сглаживает arrow для не-overlapping shapes.

Что **в backlog** (явный extension point §13 «Custom tldraw shape per role»):
- True multi-bendpoint orthogonal routing — когда tldraw expose'нет multi-segment arrows ИЛИ через custom arrow shape util в Phase 3.
- Edge labels с background для читаемости на пересечениях.

ELK всё равно вызывается с `edgeRouting: ORTHOGONAL` — bendpoints вычисляются, но **не применяются** к tldraw arrow в v1. Они сохраняются в `meta.routing.bendPoints` для будущего рендеринга (no-op forward compatibility).

#### 3.6.6. Post-processing pipeline

После ELK, перед записью в state, **только canvas-space операции** (layout не должен знать про screen-space UI):

1. **Snap-to-grid** — округление координат до 10px multiple (визуальная аккуратность).
2. **Min-spacing guard** — пост-проверка `node-to-node distance >= 20px`; если ELK по какой-то причине поставил слишком близко (редко, но бывает с pinned constraints) — раздвигает.
3. **Preserve relative order** — для not-pinned existing nodes: после ELK сравниваем их новые vs прежние позиции; если ELK перевернул порядок без сильного выигрыша в edge length — оставляем старый порядок (heuristic: разница total edge length < 5%).

**Не делается на этом слое** (вынесено явно):
- **System UI overlap** (room badge, AI chip, version footer) — это screen-space, живёт в frontend camera/padding. Backend layout его не видит и не должен. Frontend `editor.setCameraOptions({padding})` или `zoomToBounds(..., {inset})` решает на стороне рендера. Если нужно — отдельная маленькая фронтенд-задача в backlog, не часть Phase 2.1 layout.
- **Center camera on bbox** — то же: frontend camera logic, не часть `domain/layout.ts`. backend может приложить `affectedBbox: {x,y,w,h}` в response чисто как information для frontend; что с ним делать — решает frontend.

#### 3.6.7. Performance budget

- 100 elements, batch с 5 mutations + auto-layout `affected` (5-15 элементов в ELK): < 100ms server-side.
- 1000 elements, batch с 5 mutations + `affected`: < 200ms (partial ELK call).
- 1000 elements, full `scope: "all"`: < 800ms (acceptable; редкий случай).

---

## 4. AgentContext — token-cheap read

### 4.1. Endpoint

```
GET /api/agent/context?room=…&since=N&viewport=x,y,w,h&select=id1,id2
```

`viewport` опционален. Если отсутствует — backend использует last-known viewport из `/api/viewport` (см. §4.4); если и того нет — возвращает summary без `inView`.

### 4.2. Response shape — domain-summary view

Контекст возвращает **доменное** представление, не сырые tldraw shapes:

```ts
{
  version: number,
  viewport: {x, y, w, h} | null,
  summary: {
    total: number,
    byRole: Record<Role, number>,        // {"service": 5, "datastore": 2, ...}
    topLevelGroups: GroupRef[]           // network/boundary containers
  },
  inView: ElementCompact[],              // visible in viewport, ≤30 items
  selection: ElementCompact[],           // always full
  connections: ConnectionCompact[],      // connections where any endpoint in inView∪selection
  recentOps: OpSummary[],                // last 20 domain-level ops (human-readable)
  offscreenSummary: { byRole: Record<Role, number> } | null,
  truncated?: true
}

type ElementCompact = {
  id: string;            // name, e.g. "auth"
  role: Role;
  label?: string;
  parent?: string;       // container name
  position?: {x,y};      // только если pinned via meta.position
};

type ConnectionCompact = {
  from: string; to: string;
  kind: ConnectionKind;
  label?: string;
};

type OpSummary = {
  version: number;
  source: "ai" | "user";
  summary: string;       // "defined service 'auth' in vpc-prod"  /  "connected auth → users-db (data)"
};
```

Геометрия (x/y/w/h tldraw shapes) — **не передаётся агенту** по умолчанию. Если ему нужно — есть низкоуровневый fallback `didraw state --compact` (остаётся для отладки, не рекомендуется).

Это даёт **3× экономию токенов** относительно v1-черновика этой спеки и **6-10×** относительно текущего MVP — потому что нет coords, нет width/height, нет tldraw-style props.

### 4.3. Token-budget regression test

Тест в `apps/backend/tests/agent-context.test.ts`:
- Seed: 100 elements (mix: 60 services, 20 datastores, 10 queues, 5 actors, 3 networks, 2 boundaries), 80 connections, ~30 видны в viewport 800×600.
- Assert: `JSON.stringify(response).length < 8000` для default response.
- Assert: response не содержит keys `x`/`y`/`w`/`h`/`fill`/`color` (защита от регрессии — геометрия не должна утекать в context).

Цель: для 100-элементного canvas context умещается в ~2K токенов.

### 4.4. Viewport reporting

Frontend на `editor.store.listen` слушает camera change, debounce 500ms, шлёт `POST /api/viewport {x,y,w,h,zoom}`. Backend хранит per-room в memory (не persist — viewport ephemeral). Если фронт не открыт — viewport остаётся последним; через 30 мин неактивности — wipe.

---

## 5. Data flow (end-to-end)

### 5.1. Пример: «диалог → диаграмма»

Пользователь в чате: «У нас в архитектуре есть сервис auth, который ходит в users-db. Оба внутри vpc-prod».

AI отправляет один batch:
```json
{
  "actions": [
    {"kind": "define", "role": "service",   "name": "auth"},
    {"kind": "define", "role": "datastore", "name": "users-db"},
    {"kind": "connect", "from": "auth", "to": "users-db", "kind": "data"},
    {"kind": "group", "ids": ["auth", "users-db"], "as": "network", "name": "vpc-prod"}
  ],
  "clientOpId": "sess1-batch-1",
  "layoutHint": {"mode": "layered-lr"}
}
```

Backend:
1. Validate: все роли известны, ссылки `auth`/`users-db` есть после define-шагов в этом же batch (compile.ts знает intra-batch refs).
2. Compile → PatchOp[]: 2 add-node, 1 add-edge, 1 add-group + установка `parent` у двух нод.
3. ELK layered layout (direction LR, scope `affected`) → расставляет auth слева, users-db справа, обе внутри vpc-prod boundary rect. Backend пишет `update node {x,y}` ops для каждой ноды.
4. applyPatch как одна транзакция; opLog получает один entry с source `ai`.
5. WS bus.publish → frontend рендерит через `role-render.ts`: auth = rounded rect grey, users-db = rounded rect blue-ish, arrow с label «reads/writes», vpc-prod = dashed boundary rect охватывающий обе.

AI получает:
```json
{"ok": true, "version": 4, "results": [
  {"actionIndex": 0, "elementId": "auth"},
  {"actionIndex": 1, "elementId": "users-db"},
  {"actionIndex": 2, "elementId": "c_1"},
  {"actionIndex": 3, "elementId": "vpc-prod"}
], "layout": {"applied": true, "affected": ["auth", "users-db", "vpc-prod"]}}
```

Никаких координат, никаких цветов в API. Всё detrministic из ролей.

### 5.2. AI читает context

```
AI                                 CLI                  backend
 │  didraw context --since 4       │                      │
 ├────────────────────────────────►│                      │
 │                                 │ GET /api/agent/      │
 │                                 │   context?since=4    │
 │                                 ├─────────────────────►│
 │                                 │                      │ build domain summary
 │                                 │                      │ opLog since=4 → human ops
 │                                 │◄──── {version:5,     │
 │◄────────────────────────────────│      summary:{       │
 │                                 │        total:3,      │
 │                                 │        byRole:{      │
 │                                 │          service:1,  │
 │                                 │          datastore:1,│
 │                                 │          network:1}},│
 │                                 │      recentOps:[…]}  │
```

### 5.3. User-edit (без изменений)

User перетаскивает auth: `to-patch.ts` → POST `/api/patch` → existing pipeline. Backend записывает новую позицию в `meta.position` (pinned). При следующем agent batch с layoutHint=`affected` — auth не двигается, остальные перестраиваются вокруг.

---

## 6. Backwards compatibility & user-override discipline

### 6.1. Что остаётся как было

- `/api/patch` — без изменений (frontend user-edits transport).
- `/api/state` — без изменений (debug fallback; **removed from skill cheat-sheet**).
- `/api/layout` — без изменений (internal; `layout` action wraps it).
- CLI `didraw patch --stdin`, `didraw state`, `didraw layout`, `didraw clear` — остаются как low-level (debug/manual). В skill — не упоминаются.
- 52 существующих теста должны остаться зелёными.

### 6.2. User overrides discipline

Frontend `to-patch.ts` (см. `apps/frontend/src/canvas/to-patch.ts`) сегодня отправляет `{op:"update", target:"node", id, set:{x,y,w,h,label,style}}` через `/api/patch` с `source:"user"`. Backend применяет patch — но **не** знает, что это означает «pin».

Phase 2.1 добавляет одно правило в `apps/backend/src/routes/patch.ts`:

```
on POST /api/patch with source === "user":
  for each op in ops:
    if op.op === "update" && op.target === "node" && (op.set.x ?? op.set.y) !== undefined:
      // user moved this node — pin its position
      op.set.meta ??= {};
      op.set.meta.pinned = true;
      op.set.meta.position = { x: <resulting x>, y: <resulting y> };
    if op.op === "update" && op.target === "node" && (op.set.style ?? op.set.color) !== undefined:
      // user restyled — mark style as user-owned, so role preset re-render won't clobber
      op.set.meta ??= {};
      op.set.meta.styleOwnedBy = "user";
```

Никакого нового endpoint'а, никакого изменения frontend кода — backend сам делает inference из `source:"user"` тега. Это single rule в одной функции (`patch.ts`).

**Renderer side** (frontend): `role-render.ts` берёт preset из `@didraw/domain.rolePreset(role)`, потом merge'ит сверху state's `style` если `meta.styleOwnedBy === "user"`. Иначе — preset wins (агент может обновлять preset через `define` upsert и не сломать визуал).

**Compile side** (backend): `domain/compile.ts` при upsert define **не** перезаписывает `meta.pinned`, `meta.position`, и не touch'ает `style` если `meta.styleOwnedBy === "user"`. Только label/role-default updates.

**Reset path**: явно через future action (low-priority feature; backlog).

Это один rule в одной функции — никакого plumbing через слои.

### 6.3. MCP brief deprecation

`docs/handoff/mcp-launch-brief.md` (Phase 2.1 / Task 41) — устаревает. После этой фазы пишется v2 спека MCP в Phase 2.3 со следующими tools:
- `canvas_get_context` (replaces `canvas_get_state`)
- `canvas_apply_domain` (replaces `canvas_apply_patch`)
- `canvas_get_version`
- `canvas_subscribe` (push, requires HTTP/SSE transport — отдельная задача)

---

## 7. Error handling и edge cases

| Case | Поведение |
|---|---|
| `define {role: "frobnicator"}` (unknown role) | 422, `{code:"unknown-role", actionIndex, field:"role"}` |
| `connect {from: "doesnt-exist"}` | 422, `{code:"unknown-ref", field:"from"}` |
| `define {name: "auth", role: "service"}` где уже есть `auth: datastore` | 422, `{code:"role-conflict"}` |
| `define {name: "auth"}` upsert (same role) | 200, label/meta updated, no new id |
| Unknown action kind | 422, `{code:"unknown-action"}` |
| Compile crash (bug) | 500, `{code:"compile-error"}`, лог с request-id |
| `delete` non-empty container without `cascade:true` | 422, `{code:"cascade-confirm-required", affected:[child-ids…]}` |
| `clientOpId` повтор | 200, `{ok:true, idempotent:true, version, results: cached}` |
| `dryRun:true` | 200, `results[i].generatedOps` populated, опускает opLog/canvas/bus |
| Layout engine failure (ELK timeout/crash) | actions применяются (transaction committed), response `{ok:true, layout:{applied:false, reason}}` — best-effort layout per §3.3 |

---

## 8. CLI surface

Domain-уровневые команды, по одной на action kind:

```
didraw define <role> <name> [--label "..."] [--in <container-name>] [--meta key=val,...]
didraw connect <from> <to> [--kind sync|async|data|dep] [--label "..."]
didraw group <id1>,<id2>,... --as network|boundary --name <name> [--label "..."]
didraw note --text "..." [--about <element-name>]
didraw layout [--mode layered-lr|layered-tb|tree|pack|force] [--scope all|<group-name>] [--spacing compact|normal|loose]
didraw delete <id1>,<id2>,... [--cascade]

# Batch:
didraw apply --stdin              # JSON: {actions:[...], clientOpId?, dryRun?, layoutHint?}

# Read:
didraw context [--since N]        # domain-summary view, не raw shapes
```

Все commands — single-line JSON output. Exit 0 если `ok:true`, 1 иначе. На stderr — human-readable error (для grep'а в логах).

Convenience: батч-патч можно построить пошагово (`didraw define …; didraw connect …`) — каждый вызов = отдельный POST. Для атомарности и одной auto-layout — `didraw apply --stdin` с batch JSON.

CLI integration tests — `packages/didraw-cli/tests/domain.test.ts`.

---

## 9. Skill cheat-sheet rewrite

`.claude/skills/draw/SKILL.md` существенно меняется:

- **Injected state** — заменяется с `didraw state --compact` на `didraw context` (domain summary).
- **Injected rooms list** — `didraw rooms list` (см. Phase 2.0) показывает существующие схемы из текущей папки, AI может предложить продолжить старую.
- **Примеры** — все идут через `didraw define / connect / group / note`. Раздел «PatchOp format» **удаляется** из skill (агент его не видит).
- **Roles table** — список ролей с примерами, что чем называется (`auth, payment, kafka-events, postgres-users, vpc-prod, dmz`).
- **Connection kinds table** — sync/async/data/dep с пояснениями («kind: data для DB read/write»).
- **Pattern: «эскиз → разработка»** — рекомендуется идти `dryRun:true` для крупных предложений, показать пользователю текстом, потом без dryRun.
- **Style note** — «цвета и геометрию пользователь правит сам в canvas; если он перекрасил — твои next actions это уважают».

Версия skill бампается. Изменения коммитятся в одном PR с backend/CLI.

---

## 10. Testing strategy

### 10.1. Unit tests

- `domain/validate.ts` — каждый action kind: happy path + каждая категория errors (§7 table).
- `domain/compile.ts` — каждое action kind → expected PatchOp[]. Intra-batch refs (define + connect ссылающийся на just-defined name). Deterministic.
- `domain/layout.ts` — pin support (`meta.position` honored), `affected` vs `all` scope, container-recursive layout.
- `domain/context.ts` — pure function, snapshot tests на репрезентативных canvas: empty / 1 service / mini-architecture (auth+db+vpc) / 100 elements.

### 10.2. Backend integration tests

- POST `/api/domain` happy paths: каждый action kind.
- Domain example end-to-end (§5.1): «диалог → 4 actions → готовая диаграмма» — assert на финальный state.
- Transactional rollback: invalid action в batch → ничего не записано.
- Idempotency replay (clientOpId).
- dryRun не пишет в opLog/canvas/bus.
- `/api/agent/context` token-budget regression (§4.3) + assert «никакой геометрии не утекает».
- Cascade-confirm flow.

### 10.3. Frontend + cross-stack tests

- `role-render.ts` — table-driven: каждая роль → ожидаемый tldraw shape preset (snapshot test). Импорт `rolePreset` идёт из `@didraw/domain` — assert что shared package действительно используется.
- **Pin inference end-to-end (§6.2):** POST `/api/patch` `source:"user"` с `update node {x:200, y:300}` → state.nodes[id].meta.pinned === true и `meta.position == {x:200, y:300}`. Затем agent action `define {name: same id, role: same}` upsert → координаты НЕ затронуты.
- **Style ownership end-to-end:** POST `/api/patch` `source:"user"` с `update node {style:{color:"red"}}` → `meta.styleOwnedBy === "user"`. Затем render через role-render.ts с base preset `color:"blue"` → DOM рендерит "red". Agent define upsert не меняет.
- **No false positive pin:** POST `/api/patch` `source:"ai"` с update x/y → pin **не** ставится (только user-source триггерит).

### 10.4. CLI integration

- `didraw define service auth` → check via `didraw context`.
- `didraw apply --stdin batch` — applies all-or-nothing.
- `didraw define foo bar` (unknown role) → exit 1 с readable error.

### 10.5. Playwright smoke

- Открыть `:8787`. Через CLI создать mini-architecture (4 actions из §5.1). Проверить в DOM: 2 ноды внутри dashed boundary, arrow между ними с label, ELK расставил по горизонтали (auth.x < users-db.x).

### 10.6. Performance

- Backend perf: один `/api/domain` с batch из 100 `define` + 80 `connect` + auto-layout — < 500ms server-side.
- Context perf: 1000-element canvas, `/api/agent/context` — < 50ms, JSON < 12KB.

---

## 11. Implementation plan outline

(Детальный план — через `writing-plans` skill после approval спеки.)

Высокоуровнево (13-15 tasks):

1. **`packages/didraw-domain` shared package** (new): Role/ConnectionKind/LayoutMode enums + `role-preset.ts` table + `validation.ts` (name regex, role transition rules) + `layout-modes.ts` (mode → elkOptions). TDD на чистые функции.
2. `apps/backend/src/domain/types.ts` — внутренние backend types (Element shape для state), импортирует enums из @didraw/domain.
3. `domain/validate.ts` — all error categories per §7 (TDD).
4. `domain/compile.ts` — пер-action compile + intra-batch refs + upsert semantics + `meta.styleOwnedBy` respect (TDD per §5.1).
5. `domain/layout.ts` — full ELK с compound containers, ports, pin support, partial-layout scope, **best-effort error handling** per §3.3 (TDD).
6. `domain/layout-postprocess.ts` — snap-to-grid + min-spacing + preserve-order (§3.6.6; **no** UI-overlap concerns) (TDD).
7. `domain/context.ts` — domain-summary view + no-geometry guard + derived `parent` (TDD).
8. `routes/patch.ts` — **pin inference**: source==="user" + update x/y → set meta.pinned + meta.position; source==="user" + style change → set meta.styleOwnedBy=="user" (TDD per §6.2).
9. `routes/domain.ts` + `routes/viewport.ts` + `routes/context.ts` — integration tests (transactions for actions, layout best-effort, idempotency, dryRun).
10. Frontend `role-render.ts` — импорт из `@didraw/domain.rolePreset` + port-anchor mapping (§3.6.5 v1 scope) + user-override discipline (TDD per §6.2).
11. Frontend viewport reporter (`transport/viewport.ts`, debounced ~1Hz).
12. `@didraw/client` extensions — typed domain methods.
13. CLI: `didraw define / connect / group / note / layout / delete / apply / context` (с `--mode`, без `--direction`).
14. Skill cheat-sheet rewrite (mode hints, role examples, **no PatchOp section**) + Playwright smoke (§5.1 e2e).
15. CHANGELOG + bump (0.1.0 → 0.2.0). Rebuild binary, smoke.

---

## 12. Open questions / decisions deferred

1. **Role set расширение.** v1: 8 ролей. Если daily-use покажет нужду в `cache`, `cdn`, `lambda`, `gateway` — добавим (one line in enum + one row in renderer). Не блокер.
2. **Custom tldraw shapes per role.** v1 — geo presets. Custom shape utils (например cylinder для datastore) — отдельная задача в backlog, тригер: visual feedback что geo недостаточно.
3. **MCP v2 spec** — Phase 2.3. Замещает `docs/handoff/mcp-launch-brief.md`.
4. **User-override reset** — нет в v1. Добавим если кейс реально возникнет (`meta.reset:true`-action).
5. **Layout algorithm selection** — v1 hard-coded ELK layered. Dagre/force-directed alternatives — backlog.
6. **Phase 2.0 persistence** — отдельная спека (см. §0 roadmap), включает: workspace-scoped storage + session-scoped rooms + daemon-safe ops + `didraw rooms list/archive/restore/export/import` + skill startup awareness. Делается **перед** этой фазой.

---

## 13. Extensibility — карта точек расширения

Архитектура Phase 2.1 закладывает явные extension points так, чтобы будущие фичи **добавлялись**, а не **переписывали**. Один файл = один axis of extension.

| Что хочется добавить | Где меняется | Сколько строк | Кросс-файловые правки |
|---|---|---|---|
| Новая роль (`cache`, `cdn`, `lambda`, `gateway`) | `@didraw/domain` Role enum + `role-preset.ts` table row | 2 | нет (shared package — backend и frontend подхватывают automatically) |
| Новый ConnectionKind (`stream`, `notify`) | `@didraw/domain` ConnectionKind enum + preset mapping | 2 | нет |
| Новый LayoutMode (`circular`, `swimlane`) | `@didraw/domain/layout-modes.ts` registry entry | 1 | нет, если в рамках ELK |
| Альтернативный layout engine (Cola, fCoSE, real Dagre) | `domain/layout-engines/<name>.ts` + registry entry в `layout.ts` | 1 file | нет |
| Новый action kind (`split`, `merge`, `clone`) | `domain/types.ts` discriminated union + один case в `validate.ts` и `compile.ts` | 3 файла, locally | tests in plan |
| Новый import format (D2, Draw.io, Lucidchart JSON) | `import/<format>/parse.ts` + `import/registry.ts` entry → выдаёт `DomainAction[]` | 1-2 files | нет (Import переиспользует Domain API) |
| Новый export format (Mermaid, PlantUML, Miro, Figma) | `export/<format>/serialize.ts` + `export/registry.ts` entry → принимает `CanvasState` | 1-2 files | нет |
| Custom tldraw shape для роли (вместо geo preset) | `frontend/canvas/shapes/<role>-shape.tsx` + `role-render.ts` switch case | 1-2 files | runs alongside geo |
| Новый context view (например «timeline view») | `domain/context-views/<name>.ts` + `/api/agent/context?view=...` param | 1 file | нет |
| Альтернативная LLM backend (Codex/local) | docs only — CLI/skill уже LLM-agnostic | 0 code | doc update |

**Anti-extension policy** (что не делаем как extension):
- Параллельный agent API (action + patch для агента). PatchOp **только** frontend transport — не превращается в публичный API через add-only feature toggle.
- Mode-flag style customization внутри одного шейпера. Если визуал роли требует много conditionals — лучше custom shape (extension point есть).
- "Magic strings" в action args (типа `style: "tone=green"`). Все enum'ы — типизированные unions. Если расширяем — расширяем union.

Это и есть «не переписывать в будущем»: расширение всегда сводится к **добавлению файла** в registry или **строки** в enum + соответствующая запись в один renderer/compiler. Pull-request на новую роль = два diff hunks, не refactor.

## 14. Self-check — spec coverage map

| Goal (§1.2) | Где покрыто |
|---|---|
| Domain model — primary API | §2, §3 |
| Visual is function of role | §2 (`role-render.ts`), §3.1, §10.3 |
| Layout intelligence first-class | §3.6, §10.1 #4 |
| Token-cheap context | §4 (domain summary, no geometry), §10.6 |
| PatchOp transport-only | §2.1, §6.1 |
| Idempotency, readable ids | §3.4 (upsert), §3.5 (name = id) |

| User wish | Где покрыто |
|---|---|
| диалог → красивая архитектурная диаграмма | §3, §5.1 (worked example) |
| правильные роли (сеть, сервис, БД, юзер) | §3.1 Role enum |
| красивая компоновка, не хочется перерисовывать | §3.6 (full ELK: compound, ports, orthogonal, bendpoints, post-processing snap-to-grid + min-spacing + preserve-order) |
| user правит цвет точечно сам (не агент) | §6.2 user-override discipline |
| persistence предыдущих схем в папке | Phase 2.0 (отдельная спека) |
| backup/share схем между папками | Phase 2.0 §2.4 (`didraw rooms export/import` to JSON) |
| меньше технического долга, не плодить слои | §2.1 (single domain API), §6.1 (patch — transport, не agent API) |
| dialog-driven (диалог → доска) | §5.1 worked example |
| **расширяемость без переписывания** | §13 Extensibility map — каждый axis расширения = 1-2 файла, никаких rolling refactors |
| layout-алгоритмы вместо LLM-творчества | §3.6 — ELK primary, post-processing, agent даёт intent, не coords |
| ELK на полную (compound/ports/edge routing) | §3.6.2 feature table |
| fix misleading `algorithm:"dagre"` → `elk.force` | §3.6.1 — переименование в `mode: "force"` с deprecation period |
| Cola/fCoSE «untangle» | Phase 3.x (через extension point §13 — engine registry) |
| import (Mermaid/SVG/D2/Miro) | Phase 2.4 (registry-based) |
| export (Mermaid/Miro/Figma/SVG/PNG) | Phase 2.5 (registry-based) |
| multi-LLM | Phase 2.6 |
| drawing-not-only-schemas | Phase 3.x |
| multi-user | Phase 3.x |
