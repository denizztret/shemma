# MCP install rewrite — Backlog.md-style (Design)

**Version:** 0.1
**Date:** 2026-05-18
**Status:** draft — user review pending
**Target release:** `0.14.0` (MINOR bump в pre-1.0; ломает `shemma mcp install` и `--cwd` flag)
**Tracking:** Backlog эпик [[DRW-062]], подзадачи DRW-062.01–DRW-062.06.
**Baseline reference:** https://github.com/MrLesk/Backlog.md — "MCP Integration" секция в README.

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
│    $ codex mcp add shemma shemma mcp start                         │
│    $ gemini mcp add shemma -s user shemma mcp start                │
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
- `packages/shemma-cli/src/mcp.ts` — удалить `mcpInstall`, `cmdMcpInstall`, `generateClaudeConfigSnippet`, `generateCodexConfigSnippet`, `claudeConfigPath`, `codexConfigPath`, `detectInstalledMcpConfigs`, `refreshMcpConfigs`. Удалить `--cwd` из `parseMcpStartFlags`. `cmdMcpStart` читает `SHEMMA_CWD` env вместо `flags.cwd`.
- `packages/shemma-cli/src/update.ts` — удалить вызов `refreshMcpConfigs()`. JSON output более не содержит `mcpRefreshed`.
- `packages/shemma-cli/src/daemon.ts` — `maybePrintMcpNudge()` обновить текст (см. §7).
- `packages/shemma-cli/src/index.ts` — удалить регистрацию `mcp install` подкоманды.
- `packages/shemma-mcp/src/index.ts` — `startStdio` принимает `projectDir` уже резолвленным (контракт остаётся; см. §4 для details).
- Тесты в `packages/shemma-cli/src/mcp.test.ts` (+`*.snapshot`) — удалить все assertion'ы про file-writing и refresh. Добавить тесты на env-resolution в `cmdMcpStart`.
- `README.md` — секция `## MCP integration` переписывается под client guides + manual config.
- `docs/mcp.md` — переписывается полностью.

**Что не меняется (Phase 2.3 stays intact):**
- `@shemma/mcp` server (`server.ts`, tools/*, resources, prompts, daemon.ts ensure, auto-open) — без изменений.
- Room resolver chain (7 шагов) — без изменений; backlog-discovery читает `opts.projectDir`, источник этого projectDir меняется на env, но контракт функции тот же.
- HTTP клиент / typed errors / trust model — без изменений.
- 110 MCP-тестов в `packages/shemma-mcp/` — без изменений за исключением одного места: `index.test.ts` если оно ожидает `projectDir` из `--cwd` flag (требуется sanity check при implement).

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

Никакие downstream consumers (backlog-discovery, room-resolver, resources, server.ts) не трогаются — они получают тот же тип на тот же контракт.

## 5. CLI surface changes

### 5.1 Удаляется

- `shemma mcp install [--client claude|codex] [--scope user|project] [--print] [--force]` — нет такой команды. `shemma mcp <unknown>` возвращает usage error со списком оставшихся подкоманд.
- `--cwd <path>` flag в `shemma mcp start`.

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
  Codex:          codex mcp add shemma shemma mcp start
  Gemini CLI:     gemini mcp add shemma -s user shemma mcp start
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

Сейчас `packages/shemma-cli/src/daemon.ts` печатает в stderr (один раз за процесс):

```
tip: run `shemma mcp install --client claude` (or --client codex)
     to register Shemma as MCP server
```

После rewrite — install команды нет. Новый текст:

```
tip: register Shemma as MCP server in your agent client:
       Claude Code:  claude mcp add shemma --scope user -- shemma mcp start
       Codex:        codex mcp add shemma shemma mcp start
     Full guide: docs/mcp.md
     (set SHEMMA_NO_MCP_NUDGE=1 to silence)
```

Логика "печатать один раз" остаётся (флаг в process-level state, как сейчас). Условие "печатать только если ни одного MCP entry не существует" — **удаляется**, потому что мы больше не сканируем чужие configs (нет `detectInstalledMcpConfigs`). Nudge печатается всегда при первом `daemon ensure` в процессе, гасится через env.

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

describe("parseMcpStartFlags", () => {
  it("rejects unknown --cwd flag", () => {
    expect(() => parseMcpStartFlags(["--cwd", "/foo"])).toThrow();
    // или: silently ignore unknown flag (выбрать в plan'е)
  });
});
```

Решение "throw vs silently ignore" — в plan'е (DRW-062.02); текущее `parseMcpStartFlags` molча игнорит неизвестные args, можно оставить эту семантику.

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
2. `--cwd` flag удалён из `shemma mcp start`.
3. `SHEMMA_CWD` env var (или fallback на `process.cwd()`) корректно резолвится в `cmdMcpStart`.
4. `refreshMcpConfigs()` удалена; `shemma update` не трогает client configs.
5. `README.md` `## MCP integration` переписан под client guides + manual config.
6. `docs/mcp.md` переписан, включая Team install параграф.
7. CHANGELOG `0.14.0` содержит entry с migration шагами.
8. Все existing MCP тесты (~110) проходят; `mcp.test.ts` re-focused под env-resolution.
9. `maybePrintMcpNudge()` обновлён.
10. Manual sanity: copy-paste каждой команды из `## Client guides` для доступных клиентов (минимум Claude Code, Claude Desktop, Codex) — клиент стартует, `shemma_health` отвечает.

## 13. Risks & open questions

### 13.1 Risks

- **Kiro install command** не верифицирован (`kiro-cli mcp add` существует, но синтаксис скопирован из Backlog.md README без независимой проверки). **Mitigation:** verify при `DRW-062.06` (docs sanity); если синтаксис другой — обновить docs до release.
- **Gemini CLI install command** — аналогично. Spec лист команд = верит Backlog.md, manual verify до release.
- **Claude Desktop scope** — В `claude_desktop_config.json` всегда user-scope (нет других). Документировать что Claude Desktop не имеет project-scope в отличие от Claude Code.

### 13.2 Open questions (решить в plan / при implement)

- **Unknown flag handling.** Сейчас `parseMcpStartFlags` молча игнорит неизвестные args; имеет ли смысл строго throw'ить на `--cwd` (известный obsolete flag) с понятным error? — кандидат: **throw** с сообщением "the --cwd flag was removed in 0.14.0; set SHEMMA_CWD env instead". Решить в DRW-062.03.
- **`SHEMMA_CWD` whitespace / empty handling.** Trim + treat empty as unset (см. §10.3 тесты). Решение: да, это самое предсказуемое поведение.
- **Logging при fallback на `process.cwd()`.** Нужно ли emit'ить warning в stderr "SHEMMA_CWD unset, using process.cwd()=..."? — кандидат: **нет**, чтобы не зашумлять stderr CLI-клиентов (где это норма). Можно прятать за `SHEMMA_MCP_LOG=debug` когда такая опция появится (см. Phase 2.3 out-of-v1).

## 14. References

- Backlog.md README MCP Integration section — https://github.com/MrLesk/Backlog.md (baseline).
- Phase 2.3 spec — [`2026-05-17-di-draw-mcp-adapter-design.md`](2026-05-17-di-draw-mcp-adapter-design.md) v0.4.
- Phase 2.3 plan — [`../plans/2026-05-18-phase-2-3-mcp-adapter-implementation.md`](../plans/2026-05-18-phase-2-3-mcp-adapter-implementation.md).
- Backlog эпик — DRW-062 (+ 6 подзадач).
- Memory references: [[feedback-gitflow-semver-tags]] (numeric tags, MINOR in pre-1.0), [[feedback-no-remote-push]] (local-only repo для distribution context), [[phase-2-3-followups]] §2 (этот rewrite).
