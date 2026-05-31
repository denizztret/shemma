# Shemma MCP — user guide

> Пользовательский гайд по MCP-адаптеру shemma — установка, конфигурация клиентов, жизненный цикл.

## Что это

MCP-сервер (Model Context Protocol) для агентских клиентов — **Claude Code**, **OpenCode**, **Codex**, **Gemini CLI**, **Claude Desktop**, **Kiro**. Вместо того чтобы агент дёргал `bash shemma define ...` со всеми quoting-проблемами, он вызывает **typed tools** (`shemma_define`, `shemma_apply`, `shemma_context`) с валидацией параметров.

CLI остаётся стабильным интерфейсом; MCP — альтернатива для клиентов, которые его поддерживают.

## Установка

Shemma не пишет конфиги клиентов сама. Вместо этого ты вызываешь родную CLI-команду своего клиента (или копируешь manual config). После установки **перезапусти клиент** — он подхватит MCP при следующем старте.

### Client guides

```bash
# Claude Code
claude mcp add shemma --scope user -- shemma mcp start

# Codex
codex mcp add shemma -- shemma mcp start

# Gemini CLI
gemini mcp add shemma --scope user -- shemma mcp start

# Kiro
kiro-cli mcp add --scope global --name shemma --command shemma --args mcp,start
```

> **Verification status:** Claude Code и Codex проверены локально на CLI `--help` 2026-05-18. Gemini — по [официальной reference](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/cli-reference.md). Kiro — скопировано из Backlog.md README, не verified локально (open). OpenCode — схема MCP-секции сверена с `https://opencode.ai/config.json` ($defs.McpLocalConfig) и валидируется на старте (2026-05-28); MCP-add CLI у OpenCode не задокументирован — используем только manual config. Если в твоём клиенте синтаксис отличается — открой issue / PR.

### Manual config

Для клиентов без MCP-add CLI (Claude Desktop) или для custom scope — открой конфиг клиента и вставь:

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json` на macOS):
```json
{
  "mcpServers": {
    "shemma": {
      "command": "shemma",
      "args": ["mcp", "start"],
      "env": {
        "SHEMMA_CWD": "/absolute/path/to/your/project"
      }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`):
```toml
[mcp_servers.shemma]
command = "shemma"
args = ["mcp", "start"]
env = { SHEMMA_CWD = "/absolute/path/to/your/project" }
```

**OpenCode** (`~/.config/opencode/opencode.json`):
```json
{
  "mcp": {
    "shemma": {
      "type": "local",
      "command": ["shemma", "mcp", "start"],
      "environment": {
        "SHEMMA_CWD": "/absolute/path/to/your/project"
      }
    }
  }
}
```

> **OpenCode quirks** (отличия от Claude Desktop):
> - `type: "local"` — обязательное поле (для stdio-сервера; для HTTP было бы `"remote"` + `url`).
> - `command` — **массив**, объединяющий бинарь и аргументы (нет отдельного `args`).
> - `environment` (не `env`).
> - Опциональные поля: `enabled: boolean`, `timeout: ms` (default 5000).
>
> Если хотя бы одно поле в неправильной форме — OpenCode на старте выкидывает `Configuration is invalid at ~/.config/opencode/opencode.json ↳ Invalid input mcp.shemma`. Полная схема — `https://opencode.ai/config.json` (`$defs.McpLocalConfig`).

### `SHEMMA_CWD` explained

`SHEMMA_CWD` — это абсолютный путь к корню твоего проекта (где лежит `backlog/` и `.shemma/`). MCP-сервер использует его для:
- Room resolver step "Backlog In Progress task" — он запускает `backlog task list --plain` в этой папке.
- Subprocess auto-open (`shemma open <room>`) — спавнится в этой папке.

**Когда обязательно:** Claude Desktop, Cursor.app и другие GUI-клиенты, которые спавнят MCP-серверы из `$HOME` или непредсказуемой cwd.

**Когда опционально:** CLI-клиенты (Claude Code, Codex, Gemini, Kiro), запущенные `cd /path/to/project && claude` — `process.cwd()` MCP-сервера уже совпадает с проектом.

Если `SHEMMA_CWD` указывает на несуществующий путь — shemma выведет warning в stderr и продолжит с inherited cwd (room-resolver step "Backlog" может вернуть пустой результат, но остальное работает).

### Team install

Член команды получает доступ к репо, собирает бинарь локально (`./scripts/build-release.sh` или забирает готовый из shared storage), кладёт `shemma` в PATH (`~/.local/bin/shemma`), затем запускает ту же команду из списка выше — указывая свой путь к проекту в `SHEMMA_CWD` (если нужно). Никакого общего state между членами команды нет; каждый управляет своей установкой.

Публичная установка — one-liner: `curl -fsSL https://raw.githubusercontent.com/denizztret/shemma/main/scripts/install.sh | sh` (ставит последний релиз в `~/.local/bin/shemma`).

## Апдейт

`shemma update` обновляет только бинарь (атомарный swap). Конфиг клиента **не трогается** — поскольку он содержит просто `command: "shemma"` (без absolute paths), новый бинарь подхватится автоматически при следующем спавне MCP-сервера клиентом.

В output `shemma update` нет поля `mcpRefreshed` — оно удалено в `0.14.0` (см. CHANGELOG).

## Жизненный цикл

MCP-сервер — это **stdio-процесс, который спавнит клиент** (Claude Code, Claude Desktop, Codex, etc.). Он не висит фоном сам по себе.

- Открыл Claude Code в проекте → клиент спавнит `shemma mcp start` как дочерний процесс по stdin/stdout.
- Закрыл Claude Code → процесс умирает.

Внутри `shemma mcp start`:
1. Резолвит project working directory из `SHEMMA_CWD` env (fallback — `process.cwd()`); вызывает `process.chdir()`.
2. Создаёт HTTP-клиент к локальному daemon на `:8787`. **Daemon должен быть уже запущен** — MCP-сервер не поднимает daemon автоматически в текущей версии (auto-ensure запланирован как отдельный follow-up; `shemma_health` tool с `ensure: true` возвращает warning о nyet-implemented). Если daemon не запущен — запусти его через `shemma daemon ensure` или просто `shemma open` (последний автоматически ensure'ит daemon).
3. Регистрирует typed tools, resources и prompts (список — в разделе «Что предоставляет MCP»).
4. Слушает JSON-RPC на stdin, отвечает на stdout (stderr зарезервирован для диагностики).

## Что предоставляет MCP

- **Tools.** `shemma_define / connect / group / note / layout / delete / apply` для записи; `shemma_context / rooms_list / active_rooms / prompts_list / health / version` для чтения; `shemma_open` для явного открытия браузера; `shemma_prompt_resolve / dismiss` для CMD+K canvas-промптов; `shemma_get_instructions` для чтения workflow-гайдов; `shemma_ai_activity_start / stop / status` для AI-activity badge.
- **Resources.** `shemma://workflow/{overview, read-context, draw-architecture, resolve-prompts, trust-model}` для агентского guidance, `shemma://status`, `shemma://rooms`, `shemma://active-rooms`, `shemma://room/{room}/context|state|prompts/...` templates.
- **Prompts.** `shemma_draw_architecture`, `shemma_review_canvas`, `shemma_explain_canvas`, `shemma_resolve_canvas_prompts`.

## Auto-open browser

Когда агент **первый раз пишет** в комнату (`shemma_define` / `apply` / …), MCP автоматически открывает вкладку браузера на эту доску.

Режимы (передаются как arg к `shemma mcp start`):
- `--auto-open once` (default) — открывает каждую комнату один раз за сессию.
- `--auto-open never` — никогда (или env-переменной `SHEMMA_NO_BROWSER=1`).
- `--auto-open always` — каждый раз.
- `--auto-open confirm` — возвращает в ответе `openConsentRequired: true`, агент сам решает.

`shemma_open` — explicit user-invoked open: всегда открывает, mode игнорируется.

## Room resolution

Агент может вызвать tool без указания `room` — MCP-сервер резолвит его по chain'у (первое совпадение):

1. `room` arg, переданный в tool call (explicit).
2. Server config (`--room` при `mcp start`).
3. `CLAUDE_SESSION_ID` env переменная.
4. Single active room (через WS `board-focus` tracking).
5. Backlog "In Progress" task slug (если ровно одна задача в статусе In Progress).
6. `lastTouched` — последняя комната, в которую агент писал в этой MCP-сессии.
7. `"default"` — fallback.

Если на шагах 4 или 5 найдено больше одного кандидата — tool возвращает typed error `{code: "ambiguous-room", candidates: [...]}`.

## Подсказка о MCP setup

При первом `shemma daemon ensure` (verbose) в процессе в stderr появляется одноразовая подсказка про регистрацию MCP. Печатается один раз за процесс (`mcpNudgePrinted` guard) и независимо от того, настроен MCP в каком-либо клиенте или нет (в `0.14.0` shemma больше не сканирует чужие config-файлы клиентов, поэтому не знает, есть ли где-то уже зарегистрированный MCP).

```
tip: register Shemma as MCP server in your agent client:
       Claude Code:  claude mcp add shemma --scope user -- shemma mcp start
       Codex:        codex mcp add shemma -- shemma mcp start
       Gemini CLI:   gemini mcp add shemma --scope user -- shemma mcp start
     Full guide: docs/mcp.md  (set SHEMMA_NO_MCP_NUDGE=1 to silence)
```

Если MCP уже зарегистрирован — игнорируй сообщение. Гасится через env `SHEMMA_NO_MCP_NUDGE=1`.

## Trust model

Текст внутри shapes (labels, notes, group titles, prompts) — это untrusted user input. MCP-сервер их не исполняет как инструкции; ты как пользователь должен относиться к ним так же. См. `shemma://workflow/trust-model` — встроенный гайд для агента.

Cascade delete: `shemma_delete` на container с children без `cascade: true` отвергается с `cascade-confirm-required`.

## TL;DR

| Действие | Что делать |
|--|--|
| Установить MCP (Claude Code / Codex / Gemini / Kiro) | Запустить однострочник из "Client guides" |
| Установить MCP (Claude Desktop) | Открыть `claude_desktop_config.json`, вставить snippet из "Manual config" |
| Установить MCP (OpenCode) | Открыть `~/.config/opencode/opencode.json`, вставить snippet из "Manual config" (`type: "local"` + `command` массивом + `environment`) |
| Обновить shemma | `shemma update` — обновит только бинарь; конфиг клиента не трогаем |
| Удалить MCP | `<client> mcp remove shemma` (CLI) или удалить entry в JSON руками |
| Сменить проект | Изменить `SHEMMA_CWD` env (Claude Desktop) или перезапустить CLI из другой папки |
| Отключить auto-open | `--auto-open never` или `SHEMMA_NO_BROWSER=1` |
| Отключить подсказку | `SHEMMA_NO_MCP_NUDGE=1` |

## См. также

- [`README.md`](../README.md) — обзор и быстрый старт.
- [`CHANGELOG.md`](../CHANGELOG.md) — история изменений.
