# Known issues — post-MVP

Найдены через live e2e smoke (release binary в /tmp, chrome-devtools MCP, CLI patches) после закрытия Phase 1.

## P1 — Edges не рендерятся

**Симптом:** `didraw patch` создаёт `{op:"add",target:"edge",...}` — backend сохраняет ✅, `didraw state` возвращает edges ✅, но **на canvas стрелка не появляется**.

**Корневая причина (две точки):**

1. `apps/frontend/src/App.tsx:34` — initial load берёт только `s.canvas.nodes.map(nodeToShape)`. Edges игнорируются.
2. `apps/frontend/src/App.tsx:39-62` — WS-handler имеет branches только для `op.target === "node"`. Patches `op.target === "edge"` падают сквозь, не создают tldraw arrows.

**Что нужно:**

- `apps/frontend/src/canvas/from-canvas-state.ts` — добавить `edgeToShape(e)` который маппит `Edge → TLArrowShape`. Endpoint-types:
  - `{kind:"node",id}` → `start.type: "binding"` + bound shape ID
  - `{kind:"point",x,y}` → `start.type: "point"` + coords
  - `style.arrow:"none"|"to"|"both"` → tldraw arrow heads
  - `style.dashed:true` → `props.dash: "dashed"`
- `App.tsx:30-33` — initial load: `editor.createShapes([...nodes.map(nodeToShape), ...edges.map(edgeToShape)])`.
- `App.tsx:39-62` WS-handler — добавить branches `op.target === "edge"` для add/update/delete (analogous nodes).
- `canvas/to-patch.ts` — обратный поток (user-drag создаёт/двигает arrow → POST patch). Нужно научить `diffToOps` распознавать TLArrowShape и эмитить `{target:"edge"}` ops.
- Spec ref: §3.1 `Edge` type, §3.2 frontend rendering, §3.4 echo-guard (тот же flow что для nodes).

**Тест:** Playwright (`apps/frontend/tests/golden.spec.ts`) — расширить: AI добавляет 2 ноды + 1 edge, проверить что DOM имеет `.tl-shape[data-shape-type="arrow"]`.

## P2 — Sticky note label не разделяет `\n`

**Симптом:** `didraw patch` с `label:"PostgreSQL\\n(primary)"` → бэкенд хранит строку с literal `\n`, sticky note показывает `PostgreSQL\n(primary)` (literal `\n`, не line break).

**Корневая причина:** `apps/frontend/src/canvas/richtext.ts:9-15` `labelToRichText(label)` кладёт весь label в один `{type:"text",text:label}` внутри одного `{type:"paragraph"}`. ProseMirror doc model требует **отдельный `{type:"paragraph"}` на каждую строку** для line breaks.

**Что нужно:**

```ts
export function labelToRichText(label?: string): RichTextDoc {
  if (!label) return { type: "doc", content: [{ type: "paragraph" }] };
  const lines = label.split("\n");
  return {
    type: "doc",
    content: lines.map((line) => ({
      type: "paragraph",
      content: line ? [{ type: "text", text: line }] : undefined,
    })),
  };
}
```

И зеркальное в `richTextToString` — `doc.content.map(p => p.content?.[0]?.text ?? "").join("\n")`.

**Тест:** unit-test для `labelToRichText("a\nb")` → проверить что `content.length === 2` и параграфы содержат `"a"` и `"b"` отдельно.

## P3 — `room` env-fallback в release не учитывает `CLAUDE_SESSION_ID`

**Симптом:** При запуске release binary вне Claude Code-сессии без `CLAUDE_SESSION_ID` env, storageDir резолвится в `~/.claude/projects/default-project/canvas/`. Все room'ы клиента (например, `?room=demo`) попадают в этот общий dir — теряется per-session isolation, которую обещает spec §3.5.

**Корневая причина:** `apps/backend/src/config.ts:50-57` — `storageDir` по умолчанию `~/.claude/projects/default-project/<storageSubdir>`. Hard-coded "default-project". `CLAUDE_SESSION_ID` env не читается.

**Что нужно:** добавить чтение `CLAUDE_SESSION_ID` → `<slug>`-сегмент. Если env пуст — fallback на `default-project`. Документировать в README и spec.

**Не блокер** — для single-user MVP working out of one common dir это OK. Но при multi-tab / multi-session Claude Code появится конфликт.

---

## Что НЕ баг

- **PromptDrawer показывает `1` без явного создания** — это persistent prompt из прошлой сессии (`~/.claude/projects/default-project/canvas/demo.json`). Работает as designed (per spec §3.6 prompts persist).
- **`Get a license for production` watermark внизу-справа** — это tldraw SDK license requirement (free tier). Перекрывает часть VersionFooter (`v0.0.1 · stab[le]` обрезано). Решается покупкой tldraw license или показом footer выше.
- **Стрелка в нижнюю-mystery rect** на скриншоте — это tldraw placeholder для arrow без bound endpoint, потому что edge с references `{kind:"node",id:"db"}` ссылается на shape которой нет в editor.store (см. P1). После P1-fix mystery rect исчезнет.
