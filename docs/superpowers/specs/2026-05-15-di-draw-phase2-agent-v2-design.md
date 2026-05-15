# di.draw Phase 2.1 — Agent v2: typed actions + cheap context + semantic styling

> **Status:** design (v1, 2026-05-15) — pending user review
> **Predecessor:** `2026-05-14-di-draw-design.md` v3.7 (Phase 1 MVP, shipped)
> **Roadmap context:** this spec is one of six Phase 2 sub-projects (см. §0)

## 0. Phase 2 roadmap (контекст)

MVP закрыт (52 коммита на main, single-binary verified). Двигаемся к daily-use release. Сообщение пользователя 2026-05-15 покрыло шесть направлений, не помещающихся в одну спеку. Декомпозиция:

| ID | Sub-project | Зависимости | Spec status |
|----|---|---|---|
| **2.1** | Agent v2 — typed actions, cheap context, semantic palette | — | **этот документ** |
| **2.2** | Roundtrip & sync hardening (user-arrows, ack/replay, no-silent-fail) | parallel/after 2.1 | TBD |
| **2.3** | MCP adapter v1 (read + actions, не сырой patch) | requires 2.1 | TBD (replaces `docs/handoff/mcp-launch-brief.md`) |
| **2.4** | Import — SVG / Miro / image → shapes + auto-layout | requires 2.1 | TBD |
| **2.5** | Export — Mermaid / SVG / PNG / Miro / Figma | requires 2.4 | TBD |
| **2.6** | Multi-LLM hardening (Claude / Codex / corporate) | docs-only, after 2.1-2.3 | TBD |
| 3.x | Drawing-as-first-class, multi-user shared rooms | deferred | — |

Этот документ покрывает только **2.1**. Каждый следующий sub-project получит свою спеку и план.

---

## 1. Цели и неуспех

### 1.1. Что должно стать правдой после Phase 2.1

1. **Агент пишет в canvas через typed actions** (`didraw act create-node …`, `didraw act --stdin <batch>`, `mcp.canvas_apply_action(...)`), а не через сырой PatchOp.
2. **Семантика стилей**: команда «зелёный блок» детерминированно даёт идиоматичный tldraw-вид (зелёная обводка + полупрозрачная зелёная заливка) — без догадок и LLM-творчества.
3. **Token-cheap context**: AI читает компактное view-aware представление вместо full snapshot. Для 100-нодового canvas — целевой объём ≤ 8KB JSON (≤ ~2K tokens) против 20-40KB сегодня.
4. **PatchOp остаётся** как low-level транспорт для фронтенда (user-edits → backend) и backwards compatibility — нет breaking changes для существующих сессий и CLI consumers.
5. **Деterministic ids + idempotency** — agent может безопасно повторить действие после network glitch без дубликатов.

### 1.2. Что НЕ цель этой фазы

- Custom geo-shape с раздельными stroke/fill colors. Workaround через `accent: soft-fill` принимается как достаточный для v1 (см. §6 L1).
- Push-канал user-prompts → AI (B2 из known-issues). Уходит в 2.3 (MCP subscribe).
- User-нарисованные arrows → backend (B1). Уходит в 2.2.
- Inline regex-DSL «покрась/удали» без LLM (L3). Решение остаётся на уровне skill/CLI: либо AI знает action API, либо watcher переводит NL → action. Backend regex-парсер — отдельный backlog.
- Import / Export — отдельные фазы.
- Drawing (freeform), multi-user, push-MCP — Phase 3.

---

## 2. Архитектура

Новые модули в монорепо:

```
apps/backend/src/
  actions/
    types.ts          # AgentAction discriminated union + type guards
    validate.ts       # synchronous validators
    compile.ts        # AgentAction[] → PatchOp[]   (pure, deterministic)
    ids.ts            # allocateId(state, kind): collision-free
  agent/
    context.ts        # buildAgentContext(state, viewport, selection, since)
    palette.ts        # semantic styling: Tone+Accent+Emphasis → tldraw {color, fill, dash, size}
    viewport.ts       # last-known viewport per room (set by frontend on idle)
  routes/
    action.ts         # POST /api/action          (batch, dry-run)
    agent-context.ts  # GET  /api/agent/context   (cheap read)
    viewport.ts       # POST /api/viewport        (frontend reports current view)

packages/didraw-client/src/
  actions.ts          # CanvasClient.act* methods + applyActions(batch, {dryRun})
                      # also: getAgentContext(opts)

packages/didraw-cli/src/
  actions.ts          # `didraw act <kind> [args]`, `didraw act --stdin`
                      # `didraw context [--viewport …] [--since N]`

apps/frontend/src/
  canvas/palette.ts   # mirror of backend palette (no RTT for client-side use)
  transport/viewport.ts  # ~1Hz debounced POST when camera moves
```

§3.8 контракт из spec v3.7 сохраняется — никаких `position:fixed` overlay'ев, никаких новых UI элементов в этой фазе (proposal preview — sticky-note + meta, не custom shape).

### 2.1. Почему action layer поверх patch, а не вместо

PatchOp — это «assembly» canvas state: маленькие, totally-ordered, easily-mergeable операции. Frontend генерирует их естественно через `to-patch.ts`, и существующие 52 теста, opLog, WS-pipeline, echo-guard — на них держатся.

AgentAction — это «source code»: высокоуровневые намерения с семантикой. Они **компилируются** в PatchOp на backend перед applyPatch. Два API surface'а оправданы потому что:

- Frontend user-edits → patch (естественный output из tldraw diff)
- Agent writes → action (намерения, валидируются, проверяются на семантику)

Альтернатива «всё через actions, patch недоступен» (Подход B в брейне) — слишком инвазивна для 0.0.1 → 0.1.0 итерации. Альтернатива «actions только на CLI» (Подход C) — лишает MCP сервер общей логики и плодит дублирование.

---

## 3. AgentAction v1 schema

Discriminated union, 8 видов. Все поля строго типизированы; неизвестные поля — validation error, не silent-drop.

### 3.1. Common envelope

```ts
type ActionRequest = {
  actions: AgentAction[];
  clientOpId?: string;     // idempotency key, like /api/patch
  source?: "ai" | "user";  // default "ai"
  dryRun?: boolean;        // если true: validate+compile, не пишем canvas/opLog/bus
};

type ActionResponse =
  | { ok: true; version: number; idempotent?: true;
      results: ActionResult[]; }
  | { ok: false; errors: ActionError[]; };

type ActionResult = {
  actionIndex: number;
  generatedIds?: string[];      // newly allocated ids (для create-node/edge)
  generatedOps?: PatchOp[];     // присутствует только при dryRun=true
};

type ActionError = {
  actionIndex: number;
  field?: string;
  code: "unknown-ref" | "invalid-shape" | "unknown-action" | "compile-error" | "id-conflict";
  message: string;
};
```

Транзакционность: либо все action в batch применяются, либо ни один. При validation/compile error — 422, ничего не пишем.

### 3.2. The 8 actions

| Kind | Args | Compiles to | Notes |
|---|---|---|---|
| `create-node` | `{kind: NodeKind; label?: string; at?: {x,y}; size?: {w,h}; style?: Semantic; meta?: object}` | `add node` | `id` allocated by backend. Если `at` не задан — `{x:0, y:0}` (пользователь/agent позже сделает `layout`). |
| `create-edge` | `{from: Endpoint; to: Endpoint; label?: string; style?: EdgeSemantic; meta?: object}` где `Endpoint = string \| {x,y}` (id или free-point) | `add edge` | id allocated. |
| `restyle` | `{id: string; style: Semantic\|EdgeSemantic}` | `update node\|edge` | Deep-merge как сейчас. |
| `move` | `{id: string; to?: {x,y}; by?: {dx,dy}}` | `update node` | Ровно одно из `to`/`by`. |
| `relabel` | `{id: string; label: string}` | `update node\|edge` | `label: ""` — снимает label. |
| `delete` | `{id: string} \| {ids: string[]}` | `delete` per id | Cascade — как сейчас (edges → groups). |
| `layout` | `{algorithm?: "elk-layered"\|"dagre"; nodeIds?: string[]}` | wrap `/api/layout` | Не идёт через compile — отдельная ветка с тем же error-shape. |
| `propose` | `{title: string; rationale?: string; actions: AgentAction[]}` | one `add node` (proposal sticky) | Body actions embedded in `meta.proposal`. См. §3.5. |

### 3.3. Semantic style vocabulary

```ts
type Tone =
  | "black" | "grey"
  | "red" | "orange" | "yellow"
  | "green" | "blue" | "violet" | "light-violet";

type Accent = "outline" | "soft-fill" | "solid-fill";
//                ↓             ↓              ↓
// tldraw fill: "none"        "semi"         "solid"

type Emphasis = "normal" | "strong" | "dashed";
//                 ↓          ↓            ↓
// tldraw size:   "m"        "l"          "m"
// tldraw dash:  "solid"   "solid"      "dashed"

type Size = "s" | "m" | "l";   // node w/h preset; ignored if size {w,h} provided

type Semantic = {
  tone?: Tone;
  accent?: Accent;       // default "outline" для geo, "solid-fill" для note
  emphasis?: Emphasis;   // default "normal"
  size?: Size;           // node only
};

type EdgeSemantic = {
  tone?: Tone;
  arrow?: "none" | "to" | "both";   // default "to"
  emphasis?: Emphasis;              // dashed → tldraw dashed
};
```

Mapping table (full, `palette.ts`):

| Semantic input | → tldraw output |
|---|---|
| `{tone:"green", accent:"soft-fill"}` | `{color:"green", fill:"semi"}` |
| `{tone:"green", accent:"solid-fill"}` | `{color:"green", fill:"solid"}` |
| `{tone:"red", accent:"outline", emphasis:"strong"}` | `{color:"red", fill:"none", size:"l"}` |
| `{tone:"black", emphasis:"dashed"}` (edge) | `{color:"black", dash:"dashed"}` |

«Зелёная обводка + светло-зелёная заливка» из user prompt 2026-05-15 — это `{tone:"green", accent:"soft-fill"}`. Один цвет, два визуальных слоя — это всё, что позволяет tldraw geo без custom shape (см. L1).

### 3.4. ID allocation

`allocateId(state, kind)`:
- node: `n_${nextN}` где `nextN` = `max(N | exists id matching /^n_(\d+)$/) + 1`, иначе `1`.
- edge: `e_${nextN}` (по тому же правилу для `/^e_(\d+)$/`).
- group: `g_${nextN}`.
- proposal: `p_${nextN}`.

Если в state есть id, не matching pattern (например импортированный UUID) — он не влияет на счётчик; новые ids не коллизируют с ним, потому что pattern строго `prefix_digits`. Deterministic, читабельно, no UUIDs.

При concurrent action batches — backend serializes по room mutex (room state однопоточный сейчас, см. `apps/backend/src/rooms.ts`).

### 3.5. Proposal flow (v1: schema-only)

`propose` action создаёт sticky-note (kind:"sticky") с:
- `label`: `"📋 " + title` (видно на canvas)
- `meta.proposal`: `{title, rationale?, actions: [...]}` — embedded payload
- `style: {tone: "yellow", accent: "soft-fill"}`
- `at`: рядом с upper-left актуального viewport, или (0,0) если viewport unknown

UI кнопок Apply/Reject — НЕ в этой фазе. Backend exposes proposal через `/api/agent/context.proposals[]` (отдельный массив, не смешиваем с recent ops). Пользователь видит карточку, может вручную сказать AI «apply proposal p_3» — AI читает `meta.proposal.actions` и шлёт через `/api/action`.

UI integration с PromptDrawer — backlog Phase 2.5.

---

## 4. AgentContext — token-cheap read

### 4.1. Endpoint

```
GET /api/agent/context?room=…&since=N&viewport=x,y,w,h&select=id1,id2
```

`viewport` опционален. Если отсутствует — backend использует last-known viewport из `/api/viewport` (см. §4.4); если и того нет — возвращает summary без `inView`.

### 4.2. Response shape

```ts
{
  version: number,
  viewport: {x, y, w, h} | null,
  inView: NodeCompact[],         // intersect with viewport, ≤30 items
  selection: NodeCompact[],      // always full, no truncation
  edges: EdgeCompact[],          // edges where any endpoint in (inView ∪ selection)
  recentOps: OpSummary[],        // since opLog, max 20 entries
  offscreenSummary: {
    total: number,
    byKind: Record<NodeKind, number>,
    boundingBox: {minX, minY, maxX, maxY}
  } | null,
  proposals: ProposalSummary[],  // open proposals (kind:"sticky" with meta.proposal)
  truncated?: true               // если opLog window истёк для since
}
```

`NodeCompact`: `{id, kind, x, y, w?, h?, label?, style?}` — то же, что текущий compact, но без meta (для AI редко нужно). `EdgeCompact`: аналогично.

`OpSummary`: `{version, source, kindSummary}` где `kindSummary` — sparse строка типа `"add 2 nodes, delete e_3"` (не raw ops — это уже компиляция диффа в человекочитаемое; экономит токены и достаточно для context).

### 4.3. Token-budget regression test

Тест в `apps/backend/tests/agent-context.test.ts`:
- Seed: 100 nodes (10×10 grid, 200px gap), 50 edges, 5 of them in 800×600 viewport.
- Assert: `JSON.stringify(response).length < 8000`.

Цель: для 100-нодового canvas context умещается в ~2K токенов.

### 4.4. Viewport reporting

Frontend на `editor.store.listen` слушает camera change, debounce 500ms, шлёт `POST /api/viewport {x,y,w,h,zoom}`. Backend хранит per-room в memory (не persist — viewport ephemeral). Если фронт не открыт — viewport остаётся последним; через 30 мин неактивности — wipe.

---

## 5. Data flow (end-to-end)

### 5.1. AI пишет action

```
AI (Claude/Codex)                  CLI                backend                 WS subscribers
  │ "create green rect"             │                    │                          │
  │  didraw act create-node \       │                    │                          │
  │     --kind rect --label "API" \ │                    │                          │
  │     --style "tone=green,        │                    │                          │
  │              accent=soft-fill"  │                    │                          │
  ├────────────────────────────────►│                    │                          │
  │                                 │ POST /api/action   │                          │
  │                                 ├───────────────────►│                          │
  │                                 │                    │ validate                 │
  │                                 │                    │ allocateId → "n_5"       │
  │                                 │                    │ palette: tone+accent     │
  │                                 │                    │   → {color:green,        │
  │                                 │                    │      fill:semi}          │
  │                                 │                    │ compile → [PatchOp]      │
  │                                 │                    │ applyPatch (existing)    │
  │                                 │                    │ opLog/version/bus.pub ──►│
  │                                 │                    │                          │
  │                                 │◄──── {ok, version, │                          │
  │◄────────────────────────────────│      generatedIds:["n_5"]}                    │
```

### 5.2. AI читает context

```
AI                                 CLI                  backend
 │  didraw context --since 42      │                      │
 ├────────────────────────────────►│                      │
 │                                 │ GET /api/agent/      │
 │                                 │   context?since=42   │
 │                                 ├─────────────────────►│
 │                                 │                      │ derive inView from
 │                                 │                      │   last-known viewport
 │                                 │                      │ filter opLog since=42
 │                                 │                      │ build response
 │                                 │◄──── {version,       │
 │◄────────────────────────────────│      inView:[…],     │
 │                                 │      recentOps:[…]}  │
```

### 5.3. Frontend user-edits (без изменений)

User двигает shape → `to-patch.ts` строит PatchOp → POST `/api/patch` → existing pipeline. Action API не задействован.

---

## 6. Backwards compatibility

- `/api/patch` — без изменений. Сохраняется в client/CLI.
- `/api/state` — без изменений (но deprecated в skill cheat-sheet в пользу `/api/agent/context`).
- `/api/layout` — без изменений. `act layout` — алиас.
- CLI `didraw patch --stdin`, `didraw state`, `didraw layout`, `didraw clear` — без изменений (помечается «low-level»).
- 52 существующих теста должны остаться зелёными после реализации.
- MCP brief (`docs/handoff/mcp-launch-brief.md`) — устаревает. После 2.1 пишется новая v2 спека MCP, которая использует `/api/action` + `/api/agent/context` вместо `applyPatch`/`getState`.

---

## 7. Error handling и edge cases

| Case | Поведение |
|---|---|
| Action references unknown id (`move {id:"n_99"}`, n_99 not exists) | 422, `{code:"unknown-ref", actionIndex, field:"id"}` |
| `create-edge` endpoint id not exists | 422, `{code:"unknown-ref"}` |
| `move` with both `to` и `by` | 422, `{code:"invalid-shape"}` |
| Unknown action kind | 422, `{code:"unknown-action"}` |
| Compile crash (bug) | 500, `{code:"compile-error"}`, лог с request-id |
| ID collision (concurrent batches) | retry once internally; если повтор — 500 `{code:"id-conflict"}` |
| `clientOpId` повтор | 200 `{ok:true, idempotent:true, version, results: cached}` |
| `dryRun:true` | 200 `{ok:true, version: r.version, results: [{actionIndex, generatedOps, generatedIds}]}`, без mutations |
| Validation OK но `palette` не знает `tone` (нерасширенный список) | 422 `{code:"invalid-shape", field:"style.tone"}` — лучше отказ, чем silent-drop |

---

## 8. CLI surface

```
didraw act create-node --kind rect --label "API" [--at x,y] [--size WxH] [--style "tone=green,accent=soft-fill"]
didraw act create-edge --from n_1 --to n_2 [--label "uses"] [--style "tone=grey,arrow=to,emphasis=dashed"]
didraw act restyle --id n_3 --style "tone=red,accent=outline,emphasis=strong"
didraw act move --id n_3 --to 100,200          # или --by 50,0
didraw act relabel --id n_3 --label "new label"
didraw act delete --ids n_3,n_4
didraw act layout [--algorithm elk-layered] [--node-ids n_1,n_2]
didraw act propose --title "Add gateway" --stdin   # actions read from stdin JSON

# Batch:
didraw act --stdin                # JSON: {actions:[…], clientOpId?, dryRun?}

# Read:
didraw context [--since N] [--viewport x,y,w,h]
```

Output (как и сейчас) — single-line JSON. Exit code 0 если `ok:true`, 1 иначе.

CLI integration tests в `packages/didraw-cli/tests/actions.test.ts`.

---

## 9. Skill cheat-sheet rewrite

`.claude/skills/draw/SKILL.md` переписывается:

- Injected state меняется с `didraw state --compact` на `didraw context --since 0` (для первого запуска — full; AI отслеживает `version` сам).
- Примеры: все «как создать ноду» — через `didraw act create-node`, не через `echo '{ops:…}' | didraw patch --stdin`.
- Раздел «PatchOp format» помечается «low-level — only if action API doesn't fit».
- Добавляется «Semantic style palette» с таблицей tone+accent.
- Добавляется «Proposal pattern» — когда AI хочет сделать большое изменение, шлёт `propose` и ждёт пока пользователь подтвердит.

Версия skill бампается, изменение коммитится в одном PR с backend/CLI.

---

## 10. Testing strategy

### 10.1. Unit tests

- `actions/validate.ts` — каждый action kind: happy path + каждая категория errors.
- `actions/compile.ts` — каждый action → expected PatchOp[]. Deterministic.
- `actions/ids.ts` — collision на empty/sparse/full state.
- `agent/palette.ts` — full table coverage tone × accent × emphasis. Геометрические проверки size→{w,h}.
- `agent/context.ts` — pure function, snapshot tests for representative canvas shapes (empty, single-node, 10 nodes inViewport, 100 nodes with viewport).

### 10.2. Backend integration tests

- POST `/api/action` happy paths: каждый action kind.
- Transactional rollback: invalid action in batch → ничего не записано.
- Idempotency replay.
- dryRun не пишет в opLog.
- `/api/agent/context` token-budget regression (см. §4.3).

### 10.3. CLI integration

- `didraw act create-node` → side-effect через `didraw state --compact`.
- `didraw act --stdin batch` — applies all-or-nothing.
- `didraw act create-node --style "tone=foo"` → exit 1 с readable error.

### 10.4. Frontend smoke (Playwright)

- Открыть `:8787`, через CLI создать node с `tone=green,accent=soft-fill`, проверить что в DOM рендерится geo shape с правильными атрибутами (color="green", fill="semi").

### 10.5. Performance

- Backend perf-тест: один POST `/api/action` с batch из 1000 `create-node` — server-side handling должно укладываться < 500ms (включая validate+compile+applyPatch, без сетевого latency).
- Context perf: 1000-node canvas, `/api/agent/context` (viewport 800×600 захватывает ~30 нод) — server-side < 50ms, JSON < 12KB.

---

## 11. Implementation plan outline

(Детальный plan генерируется через `writing-plans` skill в отдельном документе после approval этой spec'и.)

Высокоуровнево:

1. Types + Validator + Compiler skeleton (TDD).
2. Palette module (TDD, table-driven tests).
3. ID allocator (TDD).
4. `/api/action` route + integration tests (transactionality, idempotency, dryRun).
5. `agent/context.ts` + viewport store + `/api/agent/context` route.
6. `/api/viewport` route + frontend debounced reporter.
7. CanvasClient extensions (`actions.ts`).
8. CLI commands (`didraw act`, `didraw context`).
9. Skill cheat-sheet rewrite + verification.
10. Token-budget + perf regression tests.
11. CHANGELOG + bump version (0.0.1 → 0.1.0 предлагается).
12. Single-binary rebuild + smoke verify.

Каждый шаг — отдельная Task в плане. Estimated total: ~10-14 tasks vs Phase 1's 47, потому что backend foundation готов.

---

## 12. Open questions / decisions left to writing-plans

1. **Tone palette size** — 9 цветов покрывают tldraw enum, оставляем все. Если urgent — можно ужать в Phase 2.5 на основе usage telemetry.
2. **Action `propose` UI integration** — оставлено как sticky+meta в 2.1; PromptDrawer integration с кнопками Apply/Reject — отдельная задача (потенциально Phase 2.5).
3. **Custom geo shape для раздельного stroke/fill** (закрытие L1 полностью) — пока workaround. Тригер для full fix — пользовательский запрос «нужны разные цвета обводки и заливки» (помечаем в backlog).
4. **`didraw context` vs `didraw state --compact` в skill injected block** — оба остаются, но дефолт меняется на `context`. CLI fallback (`state --compact`) — для случаев когда нужен полный снимок.
5. **MCP v2** — после Phase 2.1 нужно обновить `mcp-launch-brief.md` (или создать v2). Tools: `canvas_get_context` (replaces `canvas_get_state`), `canvas_apply_action` (replaces `canvas_apply_patch`), `canvas_get_version`. Это уже Phase 2.3 scope, здесь только helper-note.

---

## 13. Self-check — spec coverage map

| Goal (§1.1) | Где покрыто |
|---|---|
| typed actions | §3, §8 |
| semantic styling | §3.3, §6 L1 mitigation |
| token-cheap context | §4, §10.5 |
| PatchOp coexists | §2.1, §6 |
| deterministic ids + idempotency | §3.1, §3.4, §7 |

| User wish (msg 2026-05-15) | Где покрыто / в каком sub-project |
|---|---|
| canvas ↔ LLM через chat | §3, §4 (this spec) |
| fast & cheap on tokens | §4, §10.5 (this spec) |
| local-first, no SaaS | preserved — backend changes are additive |
| agent uses all tools (green outline + green soft fill) | §3.3 mapping table (this spec) |
| import Miro / SVG / image with layout | Phase 2.4 (separate spec) |
| export to Miro / Figma | Phase 2.5 (separate spec) |
| multi-LLM | Phase 2.6 (separate spec) |
| drawing not just schemas | Phase 3.x (deferred) |
| multi-user | Phase 3.x (deferred) |
| roundtrip correctness | Phase 2.2 (separate spec) |
