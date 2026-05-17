# MCP launch brief — Phase 2.1 / Task 41

**Цель:** добавить `@shemma/canvas-mcp` — тонкий MCP-server поверх `@shemma/client`, чтобы AI мог работать с canvas через MCP tools (typed schema, чище чем Bash через `shemma` CLI).

**Состояние:** не начато. План — `docs/superpowers/plans/2026-05-14-di-draw-implementation.md`, lines 4785-4914 (Task 41). Spec — `docs/superpowers/specs/2026-05-14-di-draw-design.md` §2 #5, §2.5 (CLI-first), §3.5.

**Не блокирует MVP** — Bash через `shemma` CLI уже даёт AI полный доступ к canvas. MCP — улучшение DX (typed tools, чище transcript, меньше escape-ошибок).

---

## Запуск одной командой

```
/superpowers:subagent-driven-development

Plan: docs/superpowers/plans/2026-05-14-di-draw-implementation.md (lines 4785-4914)
Spec: docs/superpowers/specs/2026-05-14-di-draw-design.md (v3.7) — §2 #5, §2.5, §3.5
Brief: docs/handoff/mcp-launch-brief.md
Start: Task 41
```

---

## Файлы для создания

| Файл | Назначение |
|---|---|
| `packages/canvas-mcp/package.json` | workspace package, зависит от `@shemma/client` + `@modelcontextprotocol/sdk` |
| `packages/canvas-mcp/src/tools.ts` | список tools (thin proxy к `CanvasClient`) |
| `packages/canvas-mcp/src/index.ts` | MCP server entry — stdio transport |
| `.claude/mcp.json` | регистрация сервера (`canvas-mcp` → `bun run packages/canvas-mcp/src/index.ts`) |

---

## Корректировки плана (важно — план писался до ADR-0001 и Task 33)

### 1. **Убрать `canvas_import_mermaid`**

Per **ADR-0001** (`docs/decisions/0001-mermaid-import-location.md`) Mermaid импорт — **только browser-side** через `window.shemmaImportMermaid` (требует tldraw `Editor` mounted в DOM). `CanvasClient.importMermaid` **не существует** — план в этом месте устарел.

→ Финальный список tools: **6** (не 7): `canvas_get_state`, `canvas_apply_patch`, `canvas_layout`, `canvas_get_prompts`, `canvas_resolve_prompt`, `canvas_dismiss_prompt`, `canvas_get_version`. **Verify expected: 6** в Step 5.

### 2. **Можно добавить `canvas_get_version`** (новое)

С Task 33 `CanvasClient.getVersion()` существует. Добавить tool `canvas_get_version` — полезно для AI чтобы знать version/profile/updateAvailable.

### 3. **Не использовать `(c as any).base`**

План в одном месте обходит private-доступ. `CanvasClient` имеет публичные методы (`getState`, `applyPatch`, `layout`, `getPrompts`, `resolvePrompt`, `dismissPrompt`, `clear`, `health`, `getVersion`) — все 7 tools пишутся через них без `any`-cast.

### 4. **Проверить `@modelcontextprotocol/sdk` версию**

План указывает `^1.0.0` — выяснить текущую stable перед `bun add`. Возможно `^1.x` или `^0.6.x`. При несоответствии API подкорректировать импорты `Server`/`StdioServerTransport`/`*RequestSchema`.

### 5. **`.claude/mcp.json` — отдельный файл**

Subagent **может** его создать (security-block только на `.claude/settings.json` / `.claude/settings.local.json`). Если subagent всё-таки заблокируется — main agent дописывает руками.

---

## Acceptance criteria

- [ ] `bun install` отрабатывает на новом workspace.
- [ ] `bun packages/canvas-mcp/src/index.ts` поднимает stdio MCP сервер без ошибок.
- [ ] `tools/list` через jsonrpc возвращает **ровно 7 tools** (см. финальный список выше — 6 base + `canvas_get_version`).
- [ ] Каждый tool ходит через `CanvasClient` (нет дублирующей логики, нет `as any`).
- [ ] inputSchema каждого tool — валидный JSONSchema.
- [ ] Регистрация в `.claude/mcp.json` корректна (Claude Code увидит сервер при перезапуске).
- [ ] `bun run lint` clean.
- [ ] `bun run test` зелёные (52+ существующих).
- [ ] (Опционально) e2e через `mcp__canvas-mcp__canvas_get_state` после перезапуска Claude Code.

---

## Test plan

```bash
# 1. tools/list smoke
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | bun packages/canvas-mcp/src/index.ts \
  | jq '.result.tools | length'
# Expected: 7

# 2. tools/call — get_state (требует daemon up)
SHEMMA_PORT=8787 bun packages/shemma-cli/src/index.ts daemon ensure
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"canvas_get_state","arguments":{"fmt":"compact"}}}' \
  | bun packages/canvas-mcp/src/index.ts \
  | jq '.result.content[0].text | fromjson | .canvas | keys'
# Expected: ["edges","groups","nodes"]
```

---

## Known unknowns / risks

1. **`@modelcontextprotocol/sdk` API surface** — может отличаться от плана (`Server` vs `McpServer`, `setRequestHandler` vs `tool()`). Implementer должен прочитать текущие docs перед написанием кода. Источник: https://github.com/modelcontextprotocol/typescript-sdk
2. **Stdio transport vs HTTP** — план использует stdio. Это правильно для local-running MCP сервера. Не менять.
3. **Workspace-resolution** — `bun run packages/canvas-mcp/src/index.ts` должен резолвить `@shemma/client` через workspace. Если падает — добавить tsconfig path mapping или использовать relative `import` от `../shemma-client/src/index`.
4. **CLAUDE_SESSION_ID** — `CanvasClient` берёт `room` из env при отсутствии opts. MCP сервер запускается в Claude Code контексте, env должно быть set. Проверить — если нет, `room=default` (это OK fallback).

---

## Commit message

```
feat: Phase 2.1 — canvas-mcp adapter (thin wrapper over shemma-client)
```

(Без trailers per project CLAUDE.md.)

---

## После завершения Task 41

- Phase 2.1 закрыт. Roadmap дальше:
  - **Phase 2.2 / Task 42** — `canvas-channel-mcp` (push canvas → Claude через Channels). План lines 4918-4972. Verify Channels wire format на момент implementation.
  - **Phase 3 / Tasks 43-45** — D2 import, SQLite persistence, multi-user merge. План lines 4976-4992.
- Обновить `README.md` секцию tools — добавить упоминание MCP как альтернативы Bash.
- Опционально: добавить `canvas-mcp` в `bun build --compile` pipeline (отдельный binary `canvas-mcp` или часть shemma multi-call binary).
