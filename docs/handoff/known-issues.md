# Known issues

> **Применимо к:** di.draw `0.0.1` (2026-05-15).
> Документ описывает поведение текущей версии. Поведение может измениться — сверяйтесь с [CHANGELOG.md](../../CHANGELOG.md) для следующих версий.

## ✅ Закрыто в `0.0.1`

История фиксов из ранних phase-1.12 итераций (commits `1bc6533`, `3a26e0e` и далее) и live-смок-сессии `0.0.1`:

- **P1 — Edges не рендерятся.** `edgeToShape` helper эмитит `TLArrow` shape + bindings. Initial load + WS forward — покрыто.
- **P2 — Sticky `\n` literal escape.** `labelToRichText` split'ит label по `\n` на отдельные ProseMirror paragraphs.
- **U1–U5 — Usability** (zoomToFit, vertical toolbar, footer overlap, и др.) — закрыты в Phase 1.12.
- **sendPatch error swallowed** — типизированный `PatchResult`, snapshot двигается только при `ok:true`.
- **Mermaid arrow labels пустые** — теперь через `renderPlaintextFromRichText`.
- **Edge selection отдавал не тот id** — `fromEdgeShapeId(id) ?? fromShapeId(id)`.
- **Esc не закрывал PromptInput** — обрабатывается до `stopPropagation`.
- **Truncated diff не сигналился** — `/api/state?since=N` возвращает `{truncated:true}`.
- **CLI port routing** для data-команд — резолвится через `--profile`.
- **Style игнорировался при рендере** — backend хранил, frontend mapper выкидывал; теперь roundtrip полный (`color`, `fill`).
- **PromptInput modifier-hold конфликтовал с tldraw drag** — заменён на `⌘K` toggle.

---

## 🔓 Открытые

### L1 — tldraw 5.x не разделяет stroke и fill colour

**Симптом:** Промпт «зелёная заливка, синяя обводка» невозможно реализовать как два разных цвета — tldraw geo использует **один** `props.color` для обводки, а `props.fill` управляет лишь типом заливки (`none|semi|solid|pattern`), используя тот же `color`.

**Severity:** Medium для UX. Backend хранит шире (`style: {color, fill, stroke}`), но `stroke` сейчас игнорируется при рендере.

**Где:** `apps/frontend/src/canvas/from-canvas-state.ts:styleToProps` — пробрасывает только `color` и `fill`.

**Workaround:** AI/watcher выбирает компромисс (`color: "green", fill: "semi"` — даёт зелёную обводку + полупрозрачную зелёную заливку).

**Possible fix:** custom geo-shape с раздельными props (overrides на shape util + миграция данных). Не приоритет для MVP.

---

### L2 — Watcher one-shot, не daemon

**Симптом:** Persistent watcher запускается ad-hoc через Agent tool в родительской Claude Code сессии; лимитирован ~5 минутами и завершается. После — pending копится без обработки.

**Severity:** Medium. Нужно вручную перезапускать.

**Где:** запуск pattern, не код.

**Possible fix:**
1. **(Текущая сессия)** — повторный запуск с большим max-iterations.
2. **(Stand-alone)** — `didraw watch` CLI-команда, дёргающая Anthropic API напрямую (требует `ANTHROPIC_API_KEY`). Backlog.

---

### L3 — Inline DSL-парсер для prompts отсутствует

**Симптом:** Простые типовые команды («покрась в красный», «удали», «сделай больше») идут через LLM-watcher с latency 3–10с. Без активного watcher'а — не применяются вовсе.

**Severity:** Medium для UX «мгновенности».

**Possible fix:** При POST `/api/prompt` backend парсит regex/word-list и сразу применяет patch + auto-resolve. Для нераспознанных — fallback к watcher'у. Latency для известных паттернов: ~50мс.

---

### P3 — `CLAUDE_SESSION_ID` env не учитывается в storage path

**Симптом:** Release binary без явного `CLAUDE_SESSION_ID` env складывает все room'ы в общий `~/.claude/projects/default-project/canvas/`. Теряется per-session isolation, обещанная spec §3.5.

**Severity:** Low. Для single-user MVP не блокер.

**Где:** `apps/backend/src/config.ts:50-57` — hard-coded `"default-project"` в `storageDir` fallback.

**Fix:** добавить чтение `process.env.CLAUDE_SESSION_ID` → `<slug>`-сегмент.

---

### B1 — User-initiated arrows не отправляются в backend

**Симптом:** Если пользователь рисует стрелку нативно через tldraw toolbar (не через AI), shape создаётся локально но не попадает в `/api/patch`. При reload пропадёт.

**Severity:** Medium для usability.

**Где:** `apps/frontend/src/canvas/to-patch.ts` — guard `if (s.type === "arrow") continue;` в `diffToOps`.

**Fix:** `shapeToEdge(s, editor)` через `editor.getBindingsToShape(arrowId, "arrow")`. Backend уже принимает edges (Tasks 6+9).

---

### B2 — Push-канал prompts → AI realtime отсутствует (без watcher'а)

**Симптом:** User создаёт prompt → backend сохраняет → frontend `PromptDrawer` обновляется. Но **AI узнаёт о новом prompt только при следующем `/draw` invocation** или явном `didraw prompts list` — если не запущен persistent watcher.

**Severity:** Medium для UX.

**Workaround:** запуск persistent watcher (см. L2).

**Long-term:** Phase 2.1 — `canvas-channel-mcp` MCP-server.

---

## ℹ️ Не баг (поведение by-design)

- **PromptDrawer показывает prompts из прошлой сессии** — persistent в `<storageDir>/<room>.json`. Per spec §3.6 prompts persist между sessions. Очистка — `🗑 N` в drawer (purge non-pending) или `didraw prompts purge`.
- **`Get a license for production` watermark** — tldraw SDK free-tier. Решается покупкой commercial license, вне scope MVP.
- **`fill: "semi"` выглядит почти прозрачным** — правильное поведение tldraw (semi = полупрозрачная заливка цветом обводки). Для plain-цветной заливки используй `fill: "solid"`.
- **`window.__editor` доступен только в dev-сборке** — gated `import.meta.env.DEV`. В release-bundle tree-shaken.
