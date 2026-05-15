# Known issues — post-MVP

## ✅ Fixed in Phase 1.12 (commits `1bc6533`, `3a26e0e`)

- **P1 — Edges не рендерятся:** ✅ Закрыт. `edgeToShape` helper эмитит `TLArrow` shape + bindings для node-anchored endpoints. Initial load + WS forward branches покрывают AI-инициированные edges. **User-initiated arrow drag → backend** ещё не round-trip'ится (см. backlog ниже).
- **P2 — Sticky `\n` literal escape:** ✅ Закрыт. `labelToRichText` теперь split'ит label по `\n` на отдельные ProseMirror paragraphs, `richTextToString` joins back. Multiline labels работают для note/text/geo.
- **U2 — Auto zoomToFit:** ✅ После initial `createShapes` → `editor.zoomToFit()` если есть контент.
- **U4 — VersionFooter overlap:** ✅ Перемещён в bottom-left над zoom controls; tldraw watermark остаётся в bottom-right отдельно.
- **U5 — Vertical toolbar:** ✅ `Toolbar` slot override в `buildTldrawComponents` рендерит `DefaultToolbar orientation="vertical"`.

---

## 🔓 Открытые

### P3 — `CLAUDE_SESSION_ID` env не учитывается в storage path

**Симптом:** Release binary без явного `CLAUDE_SESSION_ID` env складывает все room'ы в общий `~/.claude/projects/default-project/canvas/`. Теряется per-session isolation, обещанная spec §3.5.

**Severity:** Low. Для single-user MVP не блокер. При multi-tab Claude Code появится конфликт.

**Где:** `apps/backend/src/config.ts:50-57` — hard-coded `"default-project"` в `storageDir` fallback.

**Fix:** добавить чтение `process.env.CLAUDE_SESSION_ID` → `<slug>`-сегмент. Если env пуст — текущий fallback `default-project`. Документировать в README.

---

### B1 — User-initiated arrows не отправляются в backend

**Симптом:** Если пользователь рисует стрелку нативно через tldraw toolbar (не через AI), shape создаётся локально но не попадает в `/api/patch`. При reload пропадёт.

**Severity:** Medium для usability. Critical если пользователь хочет дополнять AI-сгенерированную диаграмму своими стрелками.

**Где:** `apps/frontend/src/canvas/to-patch.ts:79-105` — guard `if (s.type === "arrow") continue;` намеренно skip'ает arrows из diff'а.

**Fix:** добавить `shapeToEdge(s, editor)` который:
1. Читает `editor.getBindingsToShape(arrowId, "arrow")` для start/end terminals
2. Маппит binding `toId` → original `Edge.from/to: {kind:"node", id}`
3. Если binding отсутствует — берёт `props.start/end` как `{kind:"point", x, y}`
4. Эмитит `{op:"add"|"update", target:"edge", value:{...}}`

Backend уже принимает edges (Tasks 6+9), поэтому изменения только во frontend `to-patch.ts` + handle update в `update` op (сейчас skipped в WS handler — добавить).

---

### B2 — Push-канал prompts → AI realtime отсутствует

**Симптом:** User в UI создаёт prompt → backend сохраняет → frontend `PromptDrawer` обновляется. Но **AI узнаёт о новом prompt только при следующем `/draw` invocation** или явном `didraw prompts list`.

**Severity:** Medium для UX. Без push-канала AI не может реагировать на user prompts быстро.

**Fix:** Phase 2.2 — `canvas-channel-mcp` MCP-server по [Claude Code Channels](https://code.claude.com/docs/en/channels). См. план task 42, lines 4918-4972.

---

## ℹ️ Не баг (поведение by-design)

- **PromptDrawer `1` без явного создания** — persistent prompt из прошлой сессии (`<storageDir>/<room>.json`). Per spec §3.6 prompts persist между sessions.
- **`Get a license for production` watermark** — tldraw SDK free-tier. Решается покупкой commercial license, вне scope MVP.
