# MCP install rewrite — Backlog.md-style (Design)

**Version:** 0.2
**Date:** 2026-05-18
**Status:** draft — user review pending (v0.2 after first review pass)
**Target release:** `0.14.0` (MINOR bump в pre-1.0; ломает `shemma mcp install` и `--cwd` flag)
**Tracking:** Backlog эпик [[DRW-062]], подзадачи DRW-062.01–DRW-062.06.
**Baseline reference:** https://github.com/MrLesk/Backlog.md — "MCP Integration" секция в README.

## Changelog

- **v0.2 (2026-05-18)** — review-pass #1 fixes:
  - §4.4 added: explicit `process.chdir(projectDir)` after env resolution — устраняет gap'ы в backlog-discovery (`Bun.spawn(["backlog",...])` без cwd) и auto-open (`Bun.spawn(["shemma","open",...])` без cwd).
  - §5.1 ужесточён: `--cwd <path>` теперь **hard error** с migration message, не silent ignore. Перенесено из §13.2 (open question) в §5.1 (requirement).
  - §6/§7 snippets verified против реальных `--help` локальных CLI:
    - Codex: добавлен обязательный `--` separator (`codex mcp add shemma -- shemma mcp start`); Backlog.md README использует устаревший синтаксис.
    - Gemini: long form `--scope user` (короткое `-s user` в Backlog.md README не подтверждено; verify в §13.1).
  - §7 nudge: добавлен явный module-level `mcpNudgePrinted` guard (текущий `maybePrintMcpNudge` его не имеет).
  - §10.3: добавлены тесты на chdir behavior, neutral-cwd scenario, `--cwd` hard error, nudge once-per-process.
- v0.1 (2026-05-18) — initial draft after brainstorm.

---

## 1. Motivation

В Phase 2.3 (shipped как `0.13.0`) реализован MCP-adapter `@shemma/mcp` плюс две CLI-команды: `shemma mcp start` и `shemma mcp install`. Команда install пишет JSON напрямую в `~/Library/Application Support/Claude/claude_desktop_config.json` (Claude Desktop) или TOML в `~/.codex/config.toml` (Codex). Args снапшотят `process.cwd()` инсталлятора в виде `--cwd <absolute>`.

Это **архитектурно недозрелое решение** по сравнению с baseline (Backlog.md):

1. **Coverage gap.** `--client claude` зарегистрирован только в Claude Desktop. **Claude Code (CLI)**, Codex, Gemini CLI, Kiro используют собственные системы регистрации MCP-серверов (`claude mcp add`, `codex mcp add`, `gemini mcp add`, `kiro-cli mcp add` + `~/.claude.json`, `.mcp.json`, etc.). Текущий installer их не покрывает.
2. **Portability gap.** `--cwd /Users/<me>/Projects/...` прибит в args → config не переносится между машинами, ломается при переименовании / move папки. Team install невозможен — `process.cwd()` каждого пользователя разный.
3. **Scope gap.** В CLI клиентов есть свои scope-флаги (`--scope user|project|global`, `-s user`). Самим повторять эту матрицу в `shemma mcp install` дорого и хрупко.
4. **Trust gap.** File-writing в чужой `claude_desktop_config.json` — это запись в state приложения, которым shemma не владеет. При следующем `shemma update` `refreshMcpConfigs()` ещё раз переписывает чужой файл (с `.bak.<ts>`). Это нарушает принцип "shemma управляет своим, клиент — своим".

Backlog.md решает все четыре пункта одним приёмом: **никакого install — только инструкции в docs**.

## 2. Goal & non-goals

### 2.1 Goal

Переписать MCP-install flow shemma на Backlog.md-style:
- `shemma mcp install` удаляется полностью.
- `shemma mcp start` остаётся как entry point MCP-сервера. Удаляется `--cwd` arg.
- Рабочая директория проекта (`projectDir`) приходит **только** через `SHEMMA_CWD` env var; fallback — `process.cwd()`.
- `shemma update` больше не редактирует чужие config-файлы (`refreshMcpConfigs()` удаляется).
- Установка происходит **исключительно через docs**: `README.md` `## MCP setup` секция + `docs/mcp.md` user guide. User либо запускает родную CLI-команду клиента, либо копирует JSON manual config.

### 2.2 Non-goals (explicit)

| Non-goal | Причина |
|---|---|
| Distribution channel (npm / brew / curl install / GitHub Releases publish) | Решение private/public statusа репо тривиально и принимается отдельно. Сейчас mechanism отлаживается на single-user install (бинарь через `./scripts/build-release.sh`). |
| `shemma mcp uninstall` | Backlog.md не имеет такой команды. User удаляет entry через `<client> mcp remove shemma` или редактируя JSON руками. |
| Multi-project в одном MCP entry | Один config entry = один project (через `SHEMMA_CWD`). Несколько проектов = несколько entries (`shemma`, `shemma-foo`, `shemma-bar`). |
| Auto-migration existing `0.13.x` configs | На момент написания spec — single user (автор). CHANGELOG documents required manual changes. |
| Interactive wizard / `shemma init` | YAGNI. Backlog.md имеет `backlog init --advanced`, но это вне scope — добавим если появится реальный multi-user demand. |
| Probe client CLI availability перед записью | Не spawn'им subprocess вообще. User увидит "command not found" родного клиента напрямую. |
| Поддержка legacy `--cwd` flag как deprecated alias | Drop полностью. Pre-1.0, пользователей мало, CHANGELOG documents required changes. |

### 2.3 Versioning

`0.14.0` — MINOR bump (pre-1.0 не имеет API stability guarantee, см. `feedback-gitflow-semver-tags`; MINOR используется для feature и breaking equally до `1.0.0`).

Breaking changes:
- `shemma mcp install` команда отсутствует.
- `shemma mcp start --cwd <path>` — flag отсутствует, передаётся через env.
- `shemma update` больше не имеет полей `mcpRefreshed` / `mcpInstalled` в JSON output.

## 3. Architecture overview

```
┌────────────────────────────────────────────────────────────────────┐
│  USER ACTIONS (manual, one-time per machine)                       │
│                                                                    │
│  Option A — через CLI клиента:                                     │
│    $ claude mcp add shemma --scope user -- shemma mcp start        │
│    $ codex mcp add shemma -- shemma mcp start                      │
│    $ gemini mcp add shemma --scope user -- shemma mcp start        │
│    $ kiro-cli mcp add --scope global --name shemma                 │
│                       --command shemma --args mcp,start            │
│                                                                    │
│  Option B — manual JSON edit (Claude Desktop, custom scopes):      │
│    edit claude_desktop_config.json/<.mcp.json>/<config.toml>       │
│    paste snippet from docs/mcp.md                                  │
└────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ client spawns
┌────────────────────────────────────────────────────────────────────┐
│  shemma mcp start  (stdio MCP server)                              │
│  • reads SHEMMA_CWD env  (or process.cwd() fallback)               │
│  • connects to local daemon via http://localhost:8787              │
│  • unchanged: tools, resources, prompts, auto-open, room-resolver  │
└────────────────────────────────────────────────────────────────────┘
```

**Что меняется (focused rewrite):**
- `packages/shemma-cli/src/mcp.ts` — удалить `mcpInstall`, `cmdMcpInstall`, `generateClaudeConfigSnippet`, `generateCodexConfigSnippet`, `claudeConfigPath`, `codexConfigPath`, `detectInstalledMcpConfigs`, `refreshMcpConfigs`. Из `parseMcpStartFlags` — удалить парсинг `--cwd` как arg + добавить **targeted hard error** при встрече `--cwd` (см. §5.1). `cmdMcpStart` читает `SHEMMA_CWD` env вместо `flags.cwd`.
- `packages/shemma-cli/src/update.ts` — удалить вызов `refreshMcpConfigs()`. JSON output более не содержит `mcpRefreshed`.
- `packages/shemma-cli/src/daemon.ts` — `maybePrintMcpNudge()` обновить текст + добавить **module-level `mcpNudgePrinted` guard** (см. §7). Удалить `import { detectInstalledMcpConfigs } from "./mcp"` (функция уйдёт).
- `packages/shemma-cli/src/index.ts` — удалить регистрацию `mcp install` подкоманды.
- `packages/shemma-mcp/src/index.ts` — `startStdio` дополнительно вызывает `process.chdir(opts.projectDir)` в начале (см. §4.4); контракт `StartStdioOpts` не меняется.
- Тесты в `packages/shemma-cli/src/mcp.test.ts` (+`*.snapshot`) — удалить все assertion'ы про file-writing и refresh. Добавить тесты на env-resolution + `--cwd` hard error (см. §10.3).
- Тесты в `packages/shemma-cli/src/daemon.test.ts` — добавить тесты на nudge once-per-process guard (см. §10.3).
- Тесты в `packages/shemma-mcp/src/index.test.ts` (или новый `chdir.test.ts`) — добавить тесты на `process.chdir` поведение (см. §10.3).
- `README.md` — секция `## MCP integration` переписывается под client guides + manual config.
- `docs/mcp.md` — переписывается полностью.

**Что не меняется (Phase 2.3 stays intact):**
- `@shemma/mcp` server (`server.ts`, tools/*, resources, prompts, daemon.ts ensure, auto-open) — без изменений в коде.
- Room resolver chain (7 шагов) — контракты без изменений; backlog discovery теперь работает корректно благодаря `process.chdir` (§4.4), без правок в `backlog-discovery.ts`/`auto-open.ts`.
- HTTP клиент / typed errors / trust model — без изменений.
- 110 MCP-тестов в `packages/shemma-mcp/` — без изменений за исключением одного-двух мест: `index.test.ts` если оно ожидает `projectDir` из `--cwd` flag (требуется sanity check при implement); + потенциальные новые chdir tests.

## 4. CWD resolution

### 4.1 Resolution chain (final, выбрано в brainstorm)

```ts
// packages/shemma-cli/src/mcp.ts → cmdMcpStart
function resolveProjectDir(): string {
  const env = process.env.SHEMMA_CWD;
  if (env && env.trim().length > 0) return env;
  return process.cwd();
}
```

**Нет walk-up, нет marker detection (.shemma/ / backlog/), нет fail-fast.** Если ни env, ни cwd не дают валидной shemma-папки — backlog-discovery вернёт пустой результат, room-resolver скипнет step 5 и пойдёт дальше (step 6 → step 7 → "default"). Это **не error**, это graceful degradation: остальной MCP функционал (tools, resources, прямой room через arg / CLAUDE_SESSION_ID / active room) работает.

### 4.2 Поведение per client

| Клиент | Spawn cwd (наблюдаемое) | Нужен ли `SHEMMA_CWD` env в config? |
|---|---|---|
| Claude Code (CLI) | папка, откуда запущен `claude` | Нет — `process.cwd()` = проект. |
| Codex (CLI) | папка, откуда запущен `codex` | Нет — `process.cwd()` = проект. |
| Gemini CLI | папка, откуда запущен `gemini` | Нет — `process.cwd()` = проект. |
| Kiro | depends on Kiro client variant (CLI vs desktop) | См. §13.1 — синтаксис скопирован из Backlog.md README, требует независимой верификации до release. |
| Claude Desktop (.app) | `$HOME` или непредсказуемо | **Да** — обязательно `SHEMMA_CWD` в manual config. |

Документация (§7) явно различает эти случаи: CLI-клиенты — однострочник, Claude Desktop — manual JSON с env.

### 4.3 `projectDir` contract

`startStdio({projectDir})` API не меняется. Меняется только источник:
```ts
// Было (packages/shemma-cli/src/mcp.ts:194-206):
await startStdio({
  projectDir: flags.cwd ?? process.cwd(),
  // ...
});

// Стало:
await startStdio({
  projectDir: process.env.SHEMMA_CWD?.trim() || process.cwd(),
  // ...
});
```

### 4.4 Process working directory — explicit `chdir` (required)

Просто резолвить `projectDir` и передать в server опции **недостаточно**. Текущая реализация фактически использует projectDir только в одном месте — `resources.ts` для embed в `shemma://status`. А ключевые subprocess spawns его игнорируют:

- `packages/shemma-mcp/src/backlog-discovery.ts:44` — `Bun.spawn(["backlog", ...args], {stdout:"pipe",stderr:"ignore"})` — **без `cwd`**, наследует от родителя.
- `packages/shemma-mcp/src/auto-open.ts:48-49` — `Bun.spawn(["shemma", "open", room], {stdout:"ignore",stderr:"ignore"})` — **без `cwd` и без `env`**, тоже наследует.

В сценарии Claude Desktop spawn cwd = `$HOME` или непредсказуемо (см. §4.2). Это значит, что без явного fix:
- `backlog task list --plain ...` запустится в `$HOME` → не найдёт `backlog/tasks/` → room-resolver step 5 всегда возвращает пустой список даже когда Backlog в проекте есть.
- `shemma open <room>` запустится в `$HOME` → daemon ensure-логика стартует daemon с project-local storage `$HOME/.shemma/`, не из реального проекта.

**Решение — `process.chdir(projectDir)` в самом начале `startStdio`**, до создания MCP server и любых spawn'ов:

```ts
// packages/shemma-mcp/src/index.ts
export async function startStdio(opts: StartStdioOpts) {
  // 1. Зафиксировать project working dir для ВСЕХ subprocess spawns (backlog, shemma open).
  //    Делаем это до new McpServer / new CanvasClient.
  try {
    process.chdir(opts.projectDir);
  } catch (e) {
    // projectDir не существует — продолжаем с inherited cwd (graceful degradation,
    // см. §4.1); это редкий случай (env указывает на несуществующий path).
    process.stderr.write(`shemma mcp: SHEMMA_CWD/${opts.projectDir} not accessible, using inherited cwd\n`);
  }
  // 2. Resto unchanged.
  const client = new CanvasClient({ baseUrl: opts.baseUrl });
  // ...
}
```

**Почему chdir, а не передача `cwd` в каждый spawn:**

1. **Atomicity.** Один call покрывает все текущие и будущие subprocess spawns без необходимости их менять. backlog-discovery и auto-open остаются intact.
2. **Семантическая чистота.** MCP-сервер по сути _и есть_ "сессия в этом проекте" — глобальный cwd процесса должен это отражать.
3. **Side-effect.** Меняется global `process.cwd()`. В нашем коде это не проблема: stdio-server linear; ничего другого, рассчитывающего на inherited cwd, не работает параллельно. Если что-то такое появится — fix будет очевиден (test упадёт).

**Альтернатива (rejected):** пробрасывать `projectDir` в каждый `Bun.spawn` через `{cwd: opts.projectDir}`. Минусы:
- Изменения в 2 файлах + риск пропустить будущие spawns.
- `discoverInProgressTasks(opts)` сейчас не принимает projectDir — пришлось бы расширять signature до сшах путей.
- `defaultOpenSpawn` тоже придётся переделать.

Никакие downstream consumers (resources, room-resolver state, server.ts options) не трогаются — projectDir по-прежнему передаётся в `opts` для status resource, а subprocess'ы теперь работают сами благодаря `process.cwd()`.

### 4.5 Backlog-discovery / auto-open contracts

После §4.4 эти модули **не меняются**:

- `backlog-discovery.ts:44` `Bun.spawn(["backlog", ...args])` — продолжает работать без явного `cwd`, теперь корректно потому что `process.cwd()` = projectDir.
- `auto-open.ts:48-49` `Bun.spawn(["shemma", "open", room])` — то же самое.

Это explicit design choice: контракт "subprocesses наследуют MCP-server cwd" остаётся стабильным.

## 5. CLI surface changes

### 5.1 Удаляется

- `shemma mcp install [--client claude|codex] [--scope user|project] [--print] [--force]` — нет такой команды. `shemma mcp <unknown>` возвращает usage error со списком оставшихся подкоманд.
- `--cwd <path>` flag в `shemma mcp start`. **Это explicit hard error, не silent ignore**:

  ```
  $ shemma mcp start --cwd /Users/foo/bar
  shemma: the --cwd flag was removed in 0.14.0.
         Set SHEMMA_CWD env var instead (in your MCP client config or shell).
         See docs/mcp.md → "Setup" for the new manual config snippet.
  exit code: 1
  ```

  **Обоснование** (важно): существующие `0.13.x` configs клиентов содержат `args: ["mcp","start","--cwd","/absolute/path"]`. Если `parseMcpStartFlags` молча игнорит `--cwd` (текущая семантика для unknown flags), миграция "не до конца перенесённого" config'а тихо приведёт к запуску с inherited cwd ($HOME для Claude Desktop, §4.4) — броken state без видимой ошибки. Hard error превращает обещанный CHANGELOG migration step в принудительный: либо пользователь переписал config, либо MCP-сервер не стартует. Это согласуется с decision "drop completely" (§2.2).

  Парсер делает это _явно_ (не через "throw on unknown flag" generic): встретил `--cwd` → emit guidance message → exit 1. Другие неизвестные флаги в этой версии оставляем silent-ignore (минимальное изменение поверхности, см. §13.2 closed).

### 5.2 Остаётся (без изменений)

- `shemma mcp start [--profile dev|release|debug] [--room <id>] [--base-url <url>] [--auto-open never|once|always|confirm] [--no-auto-ensure]` — все эти флаги остаются. Только `--cwd` уходит.

### 5.3 Добавляется

Ничего. Никаких новых команд (`setup`, `guide`, `clients`) не вводим. Setup живёт **только в docs**.

### 5.4 `shemma --help` impact

В выводе `shemma mcp --help` остаётся только `start` (без `install`). В описании `start` добавляется одна строка про `SHEMMA_CWD`:

```
shemma mcp start [flags]
  Start the MCP server over stdio.
  Reads project directory from $SHEMMA_CWD env (fallback: process.cwd()).
  See docs/mcp.md for client setup.
```

## 6. Docs structure

### 6.1 `README.md` — секция `## MCP integration`

Полная замена текущей секции. Структура:

```markdown
## MCP integration

Shemma ships an MCP (Model Context Protocol) server so agentic clients
(Claude Code, Claude Desktop, Codex, Gemini CLI, Kiro) can call Shemma
through typed tools and discoverable resources without shell quoting.

The easiest way to register Shemma is to call your client's own MCP-add
command. Full guide with details, screenshots and trust model — in
[`docs/mcp.md`](docs/mcp.md).

### Client guides

  Claude Code:    claude mcp add shemma --scope user -- shemma mcp start
  Codex:          codex mcp add shemma -- shemma mcp start
  Gemini CLI:     gemini mcp add shemma --scope user -- shemma mcp start
  Kiro:           kiro-cli mcp add --scope global --name shemma \
                                   --command shemma --args mcp,start

### Manual config

For clients without a native MCP-add CLI (e.g. Claude Desktop) — paste
this into the client's MCP servers config:

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

`SHEMMA_CWD` is only required when the client spawns MCP servers from a
neutral working directory (Claude Desktop). CLI clients run from your
project root, so `SHEMMA_CWD` may be omitted.

Restart the client after editing config; it picks up `shemma` on next
start.

### What the MCP server provides

(оставляется как сейчас — Tools / Resources / Prompts блок)

### Behaviour

(оставляется как сейчас — auto-open, room resolution, trust model)

CLI remains the stable interface; MCP is an alternative for clients
that support it.
```

### 6.2 `docs/mcp.md` — переписывается полностью

Структура (по аналогии с current 0.13.1):

1. **Что это** — короткое описание (как сейчас).
2. **Установка (Setup)** — заменяется на Backlog.md-style:
   - **Client guides** блок (4-5 строк команд).
   - **Manual config** блок (JSON snippet).
   - **`SHEMMA_CWD` explained** — когда обязателен, когда опционален.
   - **Team install** — параграф: "коллега получает доступ к репо, собирает бинарь локально (`./scripts/build-release.sh`) или забирает готовый из shared storage; затем запускает ту же команду для своего клиента из своей папки проекта (`SHEMMA_CWD` каждый указывает свой). Никакого общего state между членами команды нет." Публичный distribution channel (npm / brew / curl install) — non-goal этой спеки, см. §2.2.
3. **Апдейт** — теперь короче:
   - `shemma update` обновляет только бинарь.
   - Config клиента не трогается — `command: "shemma"` всегда указывает на актуальный бинарь в PATH.
4. **Жизненный цикл MCP-сервера** — без изменений.
5. **Что предоставляет MCP** — без изменений (tools / resources / prompts).
6. **Auto-open browser** — без изменений.
7. **Room resolution** — без изменений.
8. **Подсказка при первой установке** — обновить текст под новый nudge (см. §7).
9. **Trust model** — без изменений.
10. **TL;DR** — таблица обновляется (см. §6.3).
11. **См. также** — обновить ссылки на новые spec/plan.

### 6.3 TL;DR-таблица обновлённая

| Действие | Что делать |
|--|--|
| Установить MCP (Claude Code / Codex / Gemini / Kiro) | Запустить однострочник из docs (`<client> mcp add shemma ...`) |
| Установить MCP (Claude Desktop) | Открыть `claude_desktop_config.json`, вставить snippet из docs |
| Обновить shemma | `shemma update` — обновит только бинарь; config клиента не трогаем |
| Удалить MCP | `<client> mcp remove shemma` (CLI) или удалить entry руками |
| Сменить проект | Изменить `SHEMMA_CWD` env в config (Claude Desktop) или перезапустить CLI из другой папки |
| Отключить auto-open | `--auto-open never` в args или `SHEMMA_NO_BROWSER=1` env |
| Отключить подсказку | `SHEMMA_NO_MCP_NUDGE=1` |

## 7. MCP nudge (`maybePrintMcpNudge`)

Сейчас `packages/shemma-cli/src/daemon.ts:20-35`:

```ts
function maybePrintMcpNudge(verbose: boolean): void {
  if (!verbose) return;
  if (process.env.SHEMMA_NO_MCP_NUDGE === "1") return;
  const ui = getOutput();
  if (ui.mode === "json") return;
  try {
    const detected = detectInstalledMcpConfigs();
    if (detected.some((d) => d.hasShemma)) return;
  } catch {
    return;
  }
  console.error("tip: run `shemma mcp install --client claude` ...");
}
```

Печатает в stderr:
```
tip: run `shemma mcp install --client claude` (or --client codex) to register Shemma as MCP server
```

### 7.1 Что меняется

После rewrite:
1. **`detectInstalledMcpConfigs` удаляется** (см. §5), значит условие "печатать только если нет shemma entry" — пропадает.
2. **Текст команды устаревает** (`shemma mcp install` нет).
3. **Нет explicit "once-per-process" guard**: текущая логика "не печатать если уже зарегистрировано" фактически работала как once-per-process только потому, что после первой установки `hasShemma` начинал быть `true` навсегда. Удалив detect, мы теряем этот побочный механизм — каждый `ensureDaemon(verbose=true)` в одном процессе будет печатать nudge заново.

### 7.2 Новая реализация

```ts
// packages/shemma-cli/src/daemon.ts (top of file, module-level)
let mcpNudgePrinted = false;

function maybePrintMcpNudge(verbose: boolean): void {
  if (mcpNudgePrinted) return;                       // module-level once-guard
  if (!verbose) return;
  if (process.env.SHEMMA_NO_MCP_NUDGE === "1") return;
  const ui = getOutput();
  if (ui.mode === "json") return;
  console.error(
    "tip: register Shemma as MCP server in your agent client:\n" +
    "       Claude Code:  claude mcp add shemma --scope user -- shemma mcp start\n" +
    "       Codex:        codex mcp add shemma -- shemma mcp start\n" +
    "       Gemini CLI:   gemini mcp add shemma --scope user -- shemma mcp start\n" +
    "     Full guide: docs/mcp.md  (set SHEMMA_NO_MCP_NUDGE=1 to silence)",
  );
  mcpNudgePrinted = true;
}
```

**Ключевые отличия:**
- `let mcpNudgePrinted = false` на module-level — explicit one-print per process.
- Test reset через export of internal `__resetNudgeForTesting` или через test-only re-import.
- Условие "только если ни одного entry нет" — удалено (no detect possible).
- Текст обновлён под новые команды (см. §6.3 verified).

### 7.3 Поведение

| Сценарий | Print? |
|---|---|
| First `ensureDaemon(verbose=true)` в процессе | Yes |
| Subsequent `ensureDaemon(verbose=true)` в том же процессе | No (guard) |
| `ensureSilent` (verbose=false) | No |
| `SHEMMA_NO_MCP_NUDGE=1` | No |
| `--json` output mode | No |
| Перезапуск shemma процесса | Yes (guard сбрасывается) |

Это поведение явно покрывается тестами в §10.3.

## 8. `shemma update` impact

Текущее поведение в `packages/shemma-cli/src/update.ts`:
```ts
// после atomic swap:
const refresh = refreshMcpConfigs({ projectDir: process.cwd() });
output.mcpRefreshed = refresh.refreshed;  // ["claude", "codex"]
```

Новое поведение:
```ts
// после atomic swap — никаких config-touch:
// (блок удалён)
```

JSON output `shemma update --json`:

| Поле | До (0.13.x) | После (0.14.0) |
|---|---|---|
| `version` | `"0.13.1"` | `"0.14.0"` |
| `channel` | `"stable"` | `"stable"` |
| `sha256` | hash | hash |
| `mcpRefreshed` | `["claude"]` | **removed** |

Текстовый output теряет строку `MCP config refreshed for: ...`.

## 9. Migration (user-side, one-time)

User (single — автор) после обновления до `0.14.0`:

1. Открыть `~/Library/Application Support/Claude/claude_desktop_config.json`.
2. Найти entry `mcpServers.shemma`.
3. Удалить `--cwd` и absolute path из `args`. Должно остаться:
   ```json
   "args": ["mcp", "start"]
   ```
4. Добавить `env.SHEMMA_CWD`:
   ```json
   "env": { "SHEMMA_CWD": "/Users/<...>/Projects/sandbox/di.draw" }
   ```
5. Restart Claude Desktop.

Альтернатива — снести entry и сделать `claude mcp add shemma -- shemma mcp start` для Claude Code (это другой клиент; Claude Desktop требует JSON руками, Claude Code — CLI команду).

CHANGELOG `0.14.0` секция содержит эти 5 шагов в формате "Migration from 0.13.x".

## 10. Testing strategy

### 10.1 Удалить

- `packages/shemma-cli/src/mcp.test.ts` — все тесты на `mcpInstall`, `generateClaudeConfigSnippet`, `generateCodexConfigSnippet`, `detectInstalledMcpConfigs`, `refreshMcpConfigs`, `cmdMcpInstall`. Это ~70% файла.
- Snapshot тесты для CLI snippet'ов (`*.snapshot`).

### 10.2 Сохранить

- Тесты на `parseMcpStartFlags` — кроме теста на `--cwd` (удаляется), остальное (`--profile`, `--room`, `--base-url`, `--auto-open`, `--no-auto-ensure`).
- Тесты на `cmdMcpStart` — остаются.
- Все 110 тестов в `packages/shemma-mcp/` — остаются.

### 10.3 Добавить

```ts
// packages/shemma-cli/src/mcp.test.ts (re-focused)
describe("cmdMcpStart projectDir resolution", () => {
  it("reads SHEMMA_CWD env when set", () => {
    process.env.SHEMMA_CWD = "/tmp/foo";
    // expect startStdio called with projectDir: "/tmp/foo"
  });
  it("falls back to process.cwd() when env unset", () => {
    delete process.env.SHEMMA_CWD;
    // expect startStdio called with projectDir: process.cwd()
  });
  it("trims SHEMMA_CWD whitespace", () => {
    process.env.SHEMMA_CWD = "  /tmp/foo  ";
    // expect "/tmp/foo"
  });
  it("treats empty SHEMMA_CWD as unset", () => {
    process.env.SHEMMA_CWD = "";
    // expect process.cwd()
  });
});

describe("parseMcpStartFlags --cwd hard error", () => {
  it("throws with migration message on --cwd", () => {
    expect(() => parseMcpStartFlags(["--cwd", "/foo"])).toThrow(
      /--cwd flag was removed in 0\.14\.0/,
    );
  });
  it("still silently accepts other unknown flags (minimal surface change)", () => {
    expect(() => parseMcpStartFlags(["--futureflag", "x"])).not.toThrow();
  });
});

// packages/shemma-mcp/src/index.test.ts (новые тесты для chdir behavior)
describe("startStdio chdir", () => {
  it("calls process.chdir(projectDir) before creating server", async () => {
    const chdirSpy = vi.spyOn(process, "chdir").mockImplementation(() => {});
    await startStdio({ ...validOpts, projectDir: "/tmp/somedir" });
    expect(chdirSpy).toHaveBeenCalledWith("/tmp/somedir");
    // assert: chdir invoked BEFORE first Bun.spawn or new McpServer call
  });
  it("emits stderr warning + continues when chdir throws (path missing)", async () => {
    vi.spyOn(process, "chdir").mockImplementation(() => { throw new Error("ENOENT"); });
    const stderrWrites: string[] = [];
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation((c) => {
      stderrWrites.push(String(c)); return true;
    });
    await startStdio({ ...validOpts, projectDir: "/nonexistent" });
    expect(stderrWrites.join("")).toMatch(/SHEMMA_CWD.*not accessible/);
    expect(() => /* server still constructed */ ).not.toThrow();
  });
});

// packages/shemma-mcp/src/backlog-discovery.test.ts (новый сценарий)
describe("backlog-discovery inherits chdir'd cwd", () => {
  it("Bun.spawn['backlog',...] inherits process.cwd() after chdir", async () => {
    // Сложный test — Bun.spawn реальный subprocess не легко изолировать;
    // realistically: factor runBacklogCli signature чтобы accept'ить cwd как opt;
    // или integration test с временной dir + fake `backlog` script в PATH.
    // Решение: integration test, scoped, см. plan DRW-062.03.
  });
});

// packages/shemma-cli/src/daemon.test.ts (nudge guard tests)
describe("maybePrintMcpNudge once-per-process", () => {
  // Each test needs fresh module to reset mcpNudgePrinted; используем vi.resetModules().
  beforeEach(() => { vi.resetModules(); });

  it("prints on first ensureDaemon(verbose=true)", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => { errors.push(String(m)); });
    const { ensure } = await import("./daemon");
    // mock isHealthy, etc.; trigger first call
    await ensure("release");
    expect(errors.some(e => /register Shemma as MCP server/.test(e))).toBe(true);
  });
  it("does NOT print on second ensureDaemon in same process", async () => {
    // first call printed; second call must not
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((m) => { errors.push(String(m)); });
    const { ensure } = await import("./daemon");
    await ensure("release");
    errors.length = 0;
    await ensure("release");
    expect(errors.filter(e => /register Shemma/.test(e))).toHaveLength(0);
  });
  it("does NOT print when SHEMMA_NO_MCP_NUDGE=1", async () => {
    process.env.SHEMMA_NO_MCP_NUDGE = "1";
    // ...
  });
  it("does NOT print in JSON output mode", async () => {
    // setOutput({mode:"json"}); ...
  });
  it("does NOT print on ensureSilent (verbose=false)", async () => {
    // ...
  });
});
```

**Решения:**
- `--cwd` hard error: targeted, узкая поверхность, не превращаем parser в strict. Other unknown flags остаются silent (минимальное изменение поверхности от 0.13.x).
- `process.chdir` mocked в unit tests; реальное поведение — integration test (с временной dir и stub `backlog` в PATH) в DRW-062.03.
- Nudge guard reset через `vi.resetModules()` per test — простейшее решение без exporting test-only helper.

### 10.4 Documentation tests

Не делаем automated проверку, что snippet'ы в `docs/mcp.md` синтаксически корректны (overkill). Manual sanity-check в DRW-062.06 — copy-paste каждый snippet в свежий config, проверить что клиент стартует.

## 11. Backlog deviation log

Спека ссылается на Backlog.md README MCP section как baseline. Sled diff:

| Backlog.md | Shemma `0.14.0` | Reason |
|---|---|---|
| `backlog init` опционально настраивает MCP | Нет аналога | YAGNI; явно out-of-scope §2.2. |
| Manual config поле — `env.BACKLOG_CWD` | Manual config поле — `env.SHEMMA_CWD` | Naming alignment с проектом. |
| Distribution: npm / brew / nix / bun | Local build (out-of-scope) | §2.2; решение private/public deferred. |
| Default command `backlog mcp start` (без args) | Тот же `shemma mcp start` (без args) | Идентично. |
| `--no-watch` опция в `mcp start` | Нет аналога | Out-of-scope; добавим если понадобится. |

## 12. Acceptance criteria (для DRW-062 эпика)

1. `shemma mcp install` команда удалена.
2. `--cwd` flag в `shemma mcp start` отвергается с targeted hard error (§5.1) и migration-сообщением; покрыто тестом.
3. `SHEMMA_CWD` env var (или fallback на `process.cwd()`) корректно резолвится в `cmdMcpStart`; whitespace/empty handling покрыты тестами (§10.3).
4. `process.chdir(projectDir)` вызывается в `startStdio` до создания MCP server (§4.4); graceful fallback при ENOENT (warning + продолжить); покрыто тестами.
5. `backlog-discovery` и `auto-open` после chdir работают без `cwd` в `Bun.spawn` (§4.5); integration test это подтверждает.
6. `refreshMcpConfigs()` удалена; `shemma update` не трогает client configs; JSON output не содержит `mcpRefreshed`.
7. `maybePrintMcpNudge()` обновлён: новый текст (Claude Code + Codex + Gemini snippets) + module-level `mcpNudgePrinted` guard (§7.2); поведение покрыто тестами для 5 сценариев (§7.3).
8. `README.md` `## MCP integration` переписан под Backlog.md-style (client guides + manual config с `SHEMMA_CWD`).
9. `docs/mcp.md` переписан, включая Team install параграф (§6.2).
10. CHANGELOG `0.14.0` содержит entry с migration шагами (§9).
11. Все existing MCP тесты (~110) проходят; `mcp.test.ts` re-focused под env-resolution; добавлены новые тесты на chdir + nudge guard + hard error.
12. Manual sanity: copy-paste каждой команды из `## Client guides` для доступных клиентов (минимум Claude Code, Claude Desktop, Codex) — клиент стартует, `shemma_health` отвечает; Gemini/Kiro команды verified либо локально (если CLI установлен), либо явно помечены как unverified в `docs/mcp.md` с disclaimer.

## 13. Risks & open questions

### 13.1 Risks & command source verification

| Command | Source | Verified |
|---|---|---|
| `claude mcp add shemma --scope user -- shemma mcp start` | `claude mcp add --help` (local CLI 2026-05-18) | ✅ verified; `-s`/`--scope` both work, values `local`/`user`/`project`; `--` separator required для stdio + args |
| `codex mcp add shemma -- shemma mcp start` | `codex mcp add --help` (local CLI 2026-05-18) | ✅ verified; usage line `codex mcp add [OPTIONS] <NAME> (--url <URL> \| -- <COMMAND>...)` — `--` обязателен. Backlog.md README с устаревшим `codex mcp add backlog backlog mcp start` неверен. |
| `gemini mcp add shemma --scope user -- shemma mcp start` | https://github.com/google-gemini/gemini-cli docs/cli/cli-reference.md | ⚠️ verified только по docs (gemini CLI не установлен локально). Backlog.md README использует `-s user` (short form) — требуется local verify до release. |
| `kiro-cli mcp add --scope global --name shemma --command shemma --args mcp,start` | Backlog.md README | ⚠️ unverified; kiro-cli не установлен. Если синтаксис другой — обновить README+`docs/mcp.md` до release (DRW-062.06). |

**Other risks:**
- **Claude Desktop scope** — в `claude_desktop_config.json` всегда user-scope (project / local scope недоступны). Документировать в `docs/mcp.md`, что Claude Desktop не имеет project-scope в отличие от Claude Code.
- **`process.chdir` failure** — если `SHEMMA_CWD` указывает на несуществующий path, `process.chdir` throw'нет. §4.4 определяет graceful degradation: catch + warning в stderr + продолжить с inherited cwd. Tests должны покрыть этот случай.
- **Subprocess inheriting unexpected cwd** — если в будущем кто-то добавит ещё один `Bun.spawn` без cwd в MCP-сервер, он автоматически унаследует projectDir. Это invariant из §4.4; нарушений нет на момент `0.13.x`, но stricter test pattern полезен (см. §10.3).

### 13.2 Closed in v0.2

- **`--cwd` obsolete flag handling** — закрыто в §5.1: targeted hard error с migration message. Не silent ignore, не generic "throw on unknown flag" — узкая поверхность только для известного устаревшего флага.
- **`SHEMMA_CWD` whitespace / empty handling** — закрыто в §10.3: trim + treat empty as unset.
- **Logging при fallback на `process.cwd()`** — closed: НЕ emit'им warning в stderr (CLI-клиенты получают этот fallback как норму, шум вреден). Можно прятать за `SHEMMA_MCP_LOG=debug` когда такой env появится (Phase 2.3 out-of-v1, см. [[phase-2-3-followups]] §4).
- **`process.chdir` failure при несуществующем `SHEMMA_CWD`** — закрыто в §4.4: try/catch + warning в stderr + продолжить с inherited cwd.

### 13.3 Open questions (решить в plan / при implement)

- **Kiro install command syntax** — verify до release (DRW-062.06), см. §13.1.
- **Gemini local verify** — установить `gemini` CLI на dev-машину или скипнуть Gemini support в `0.14.0` (defer до `0.14.x` patch). Решение в DRW-062.06.
- **Nudge guard test isolation** — `let mcpNudgePrinted = false` на module-level не сбрасывается между тестами в одном файле. Опция (a) `__resetNudgeForTesting` экспорт only-for-tests; (b) делать import dynamic в каждом тесте; (c) использовать `ts-jest` module reset. Решение в DRW-062.04.

## 14. References

- Backlog.md README MCP Integration section — https://github.com/MrLesk/Backlog.md (baseline).
- Phase 2.3 spec — [`2026-05-17-di-draw-mcp-adapter-design.md`](2026-05-17-di-draw-mcp-adapter-design.md) v0.4.
- Phase 2.3 plan — [`../plans/2026-05-18-phase-2-3-mcp-adapter-implementation.md`](../plans/2026-05-18-phase-2-3-mcp-adapter-implementation.md).
- Backlog эпик — DRW-062 (+ 6 подзадач).
- Memory references: [[feedback-gitflow-semver-tags]] (numeric tags, MINOR in pre-1.0), [[feedback-no-remote-push]] (local-only repo для distribution context), [[phase-2-3-followups]] §2 (этот rewrite).
