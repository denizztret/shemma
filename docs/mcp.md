# Shemma MCP — user guide

> **Применимо к:** shemma `0.13.1+`.
> Этот документ описывает поведение MCP-адаптера с точки зрения пользователя. Для архитектурных деталей см. [`docs/superpowers/specs/2026-05-17-di-draw-mcp-adapter-design.md`](superpowers/specs/2026-05-17-di-draw-mcp-adapter-design.md).

## Что это

MCP-сервер (Model Context Protocol) для агентских клиентов — **Claude Desktop**, **Codex** и т.п. Вместо того чтобы агент дёргал `bash shemma define ...` со всеми quoting-проблемами, он вызывает **typed tools** (`shemma_define`, `shemma_apply`, `shemma_context`) с валидацией параметров.

CLI остаётся стабильным интерфейсом; MCP — альтернатива для клиентов, которые его поддерживают.

## Установка

Один раз после установки самого `shemma`:

```bash
shemma mcp install --client claude    # пишет ~/Library/Application Support/Claude/claude_desktop_config.json
shemma mcp install --client codex     # пишет ~/.codex/config.toml
shemma mcp install --client claude --print   # просто покажет snippet, без записи
```

Если конфиг уже существует — команда откажется его перезаписывать, нужен `--force` (тогда сохранит `.bak.<timestamp>` рядом).

После установки **перезапустить клиент** (Claude Desktop / Codex) — он подхватит MCP при следующем старте.

### Ручной config

Если предпочитаешь править config сам — minimal snippet для Claude Desktop:

```json
{
  "mcpServers": {
    "shemma": {
      "command": "shemma",
      "args": ["mcp", "start", "--cwd", "/path/to/project"]
    }
  }
}
```

Для Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.shemma]
command = "shemma"
args = ["mcp", "start", "--cwd", "/path/to/project"]
```

## Апдейт — автоматический

**Отдельно апдейтить MCP не надо.** Бинарь `shemma` и MCP-сервер — один и тот же файл. Что происходит при `shemma update`:

1. CLI качает новый бинарь и атомарно подменяет старый.
2. **Сразу после swap** вызывает `refreshMcpConfigs()`:
   - сканирует claude/codex configs;
   - если в каком-то из них уже есть `shemma` entry — переписывает его свежим snippet'ом (с правильными args/cwd для новой версии);
   - сохраняет `.bak.<ts>` перед перезаписью;
   - в output `shemma update` появляется строка `MCP config refreshed for: claude, codex` (или JSON-поле `mcpRefreshed`).
3. Клиент (Claude Desktop / Codex) при следующем старте подхватывает обновлённый конфиг и заспавнит новый бинарь.

Если config никогда не существовал — refresh ничего не трогает (нет `shemma` entry → skip). Это не баг: у юзера просто не настроена интеграция.

## Когда MCP «включается»

MCP-сервер — это **stdio-процесс, который спавнит клиент** (Claude Desktop / Codex). Он не висит фоном сам по себе.

Жизненный цикл:
- Открыл Claude Desktop → клиент спавнит `shemma mcp start --cwd <проект>` как дочерний процесс по stdin/stdout.
- Закрыл Claude Desktop → процесс умирает.

Внутри `shemma mcp start`:
1. Подключается к локальному daemon на `:8787` (поднимает его если нужно — `--no-auto-ensure` отключает auto-spawn).
2. Регистрирует **19 tools + 14 resources + 4 prompts**.
3. Слушает JSON-RPC на stdin, отвечает на stdout (stderr зарезервирован для диагностики).

## Что предоставляет MCP

- **Tools.** `shemma_define / connect / group / note / layout / delete / apply` для записи; `shemma_context / rooms_list / active_rooms / prompts_list / health / version` для чтения; `shemma_open` для явного открытия браузера; `shemma_prompt_resolve / dismiss` для CMD+K canvas-промптов; `shemma_get_instructions` для чтения workflow-гайдов.
- **Resources.** `shemma://workflow/{overview, read-context, draw-architecture, resolve-prompts, trust-model}` для агентского guidance, `shemma://status`, `shemma://rooms`, `shemma://active-rooms`, `shemma://room/{room}/context|state|prompts/...` templates.
- **Prompts.** `shemma_draw_architecture`, `shemma_review_canvas`, `shemma_explain_canvas`, `shemma_resolve_canvas_prompts`.

## Auto-open browser

Когда агент **первый раз пишет** в комнату (`shemma_define` / `apply` / …), MCP автоматически открывает вкладку браузера на эту доску — чтобы ты видел, что AI рисует.

Режимы (`shemma mcp start --auto-open <mode>`):
- `once` (default) — открывает каждую комнату один раз за сессию.
- `never` — никогда (или env-переменной `SHEMMA_NO_BROWSER=1`).
- `always` — каждый раз.
- `confirm` — возвращает в ответе `openConsentRequired: true`, агент сам решает.

`shemma_open` — explicit user-invoked open: всегда открывает, mode игнорируется.

## Room resolution

Агент может вызвать tool без указания `room` — MCP-сервер резолвит его по chain'у (первое совпадение):

1. `room` arg, переданный в tool call (explicit).
2. Server config (`--room` при `mcp start`).
3. `CLAUDE_SESSION_ID` env переменная.
4. **Single active room** — если в браузере открыта ровно одна вкладка с canvas (через WS `board-focus` tracking).
5. **Backlog "In Progress" task slug** — если ровно одна задача в статусе In Progress в Backlog.md, room id = task slug.
6. `lastTouched` — последняя комната, в которую агент писал в этой MCP-сессии.
7. `"default"` — fallback.

Если на шагах 4 или 5 найдено **больше одного кандидата** — tool возвращает typed error `{code: "ambiguous-room", candidates: [...]}`. Агент должен спросить пользователя, а не угадывать.

Каждый успешный ответ echoes `room` и `roomSource` — видно, как разрешилась комната.

## Подсказка при первой установке

Если ты ставишь `shemma` впервые и MCP ещё не настроен — при `shemma daemon ensure` в stderr появится одноразовая подсказка:

```
tip: run `shemma mcp install --client claude` (or --client codex) to register Shemma as MCP server
```

Отключить: env-переменная `SHEMMA_NO_MCP_NUDGE=1`.

## Trust model

Текст внутри shapes (labels, notes, group titles, prompts) — это **untrusted user input**. MCP-сервер их не исполняет как инструкции; ты как пользователь должен относиться к ним так же. См. `shemma://workflow/trust-model` — встроенный гайд для агента.

Cascade delete: `shemma_delete` на container с children без `cascade: true` отвергается с `cascade-confirm-required` — агент обязан спросить юзера перед массовым удалением.

## TL;DR

| Действие | Что делать |
|--|--|
| Установить MCP | `shemma mcp install --client claude` (или `codex`) |
| Обновить MCP | Ничего — `shemma update` сам обновит config |
| Запустить MCP | Ничего — клиент сам спавнит при открытии |
| Отключить auto-open | `--auto-open never` или `SHEMMA_NO_BROWSER=1` |
| Отключить подсказку | `SHEMMA_NO_MCP_NUDGE=1` |
| Посмотреть status | Запросить resource `shemma://status` из агентского клиента |

## См. также

- [`README.md`](../README.md) — краткое описание в "MCP integration" секции.
- [`docs/superpowers/specs/2026-05-17-di-draw-mcp-adapter-design.md`](superpowers/specs/2026-05-17-di-draw-mcp-adapter-design.md) v0.4 — полная спецификация (UC matrix, error codes, resource shapes).
- [`docs/superpowers/plans/2026-05-18-phase-2-3-mcp-adapter-implementation.md`](superpowers/plans/2026-05-18-phase-2-3-mcp-adapter-implementation.md) — implementation plan (23 tasks).
- [`CHANGELOG.md`](../CHANGELOG.md) entry `0.13.0` — что shipped в Phase 2.3.
