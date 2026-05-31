# shemma

**AI-driven canvas board.** Люди и AI-агенты делят один tldraw-холст: любой MCP-совместимый агент (Claude Code, OpenCode, Codex, Gemini CLI, Claude Desktop, …) рисует и обновляет архитектурные схемы в реальном времени на той же доске, где работает человек.

Monorepo (`bun` workspace):

- `apps/backend` — Bun REST + WebSocket API, MCP-сервер, персистентность комнат (`:8787` release, `:8788` dev).
- `apps/frontend` — tldraw 5.x React-приложение (Vite).
- `packages/shemma-domain` — общие domain-типы, действия, валидация (SSOT доменной логики).
- `packages/shemma-cli` — `shemma` CLI.
- `packages/shemma-client` — `CanvasClient` HTTP-обёртка.
- `packages/shemma-mcp` — MCP-сервер.
- `packages/shemma-spaces` — реестр spaces.
- `packages/shemma-lockfile` — daemon lock utilities.

Single-binary дистрибуция через `bun build --compile` (backend + embedded UI + CLI в одном исполняемом файле).

## Build / Lint / Test

```bash
bun install                       # установка зависимостей workspace
bun run test                      # все тесты (domain/backend/client/cli/mcp), из корня
bun test src/some-feature.test.ts # один файл — из директории пакета
bun --cwd apps/backend test       # только backend
bun test --cwd apps/frontend src  # только frontend (отдельный runner)
bun run lint                      # biome (root)
SHEMMA_PROFILE=dev bun run dev    # backend + frontend параллельно (dev)
```

## Architecture

- **Core:** `CanvasState + PatchOp` REST/WS API в Bun backend.
- **Singleton daemon:** один процесс на машину обслуживает все spaces. mkdir-lock (`~/.shemma/run/<profile>.lock/`) с PID-handshake; idle-shutdown 30 мин по умолчанию. Параллельные `shemma` invocations attach'атся к существующему daemon.
- **Spaces registry:** `~/.config/shemma/spaces.json`. Каждый space = `{id, path, storageLayout, …}`. Storage layouts: `direct` (`path/<room>.json`), `claude` (legacy `~/.claude/projects/*/canvas/`), `shemma` (default: `<path>/.shemma/canvas/<room>.json`). Composite key `(spaceId, roomId)` — глобально уникален.
- **Domain layer:** типизированные действия (define/connect/group/note/layout/delete) поверх `@shemma/domain`. Агент пишет через `POST /api/domain` (CLI/MCP), не через сырой `/api/patch`.
- **Token-cheap context:** `GET /api/agent/context?since=N` — domain summary без геометрии.
- **Runtime profiles:** `release`/`debug` шарят `:8787` (одновременно не работают — singleton lock), `dev` (`:8788`, Vite HMR) — параллельно ОК.
- **MCP:** все tools принимают optional `space?`. Resolver: explicit > CWD prefix match > `default` > ambiguous.
- **UI:** tldraw editor — primary; shemma добавляет минимальный service-layer через `components`/`overrides`.

## Code style & conventions

- **Formatter/Linter:** Biome (`biome.json`) — indent 2 пробела, semicolons always, trailing commas all.
- **Runtime:** Bun (ESM, `"type": "module"`); **Language:** TypeScript strict.
- **Imports:** node built-ins через `node:`; workspace-пакеты через `@shemma/*`; named imports предпочтительнее namespace.
- **Naming:** файлы `kebab-case`; типы/интерфейсы `PascalCase`; функции `camelCase`; module-level const `SCREAMING_SNAKE_CASE`; private поля `_prefix`; тесты `*.test.ts`.
- **Types:** `type` для алиасов, `interface` для object shapes; аннотировать параметры и возврат; `unknown` для внешних данных + type guards; `Readonly<T>`/`ReadonlyArray` в публичном API.
- **Error handling:** типизированные ошибки; для ожидаемых сбоев — `{ ok: false, error, code }`; WS-обработку оборачивать в try/catch (не ронять daemon на malformed input); не глотать ошибки молча.
- **Async:** явный `Promise<T>`; `async/await` (не `.then()`-цепочки кроме параллельных промисов); не забывать `await`.

## Test patterns

```typescript
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

describe("Feature", () => {
  let srv: { port: number; close: () => Promise<void> };
  beforeAll(async () => { srv = await startServer({ port: 0, storageDir: tmpdir }); });
  afterAll(async () => { await srv.close(); });
  test("returns 200 on health check", async () => {
    const r = await fetch(`http://localhost:${srv.port}/api/health`);
    expect(r.status).toBe(200);
  });
});
```

`port: 0` — ephemeral; `tmpdir` + `mkdtempSync` для storage-изоляции; всегда cleanup в `afterAll`.

## Invariants (не ломать)

- **Domain SSOT:** все `Role`/`ConnectionKind`/`LayoutMode`/presets — из `@shemma/domain`. Никаких локальных redeclaration в backend/frontend.
- **Element identity (дуальная модель):** v1-комнаты — identity = `meta.didrawName` (slug); v2-комнаты — identity = `meta.didrawId` (stable immutable NodeId), `meta.didrawLabel` — mutable display label. Генерация — `generateNodeId` из `@shemma/domain`.
- **Container model:** `Group.children: ElementId[]` каноничен; `meta.parent` на узлах НЕ писать.
- **Pin/style ownership:** `meta.pinned + meta.position` и `meta.styleOwnedBy === "user"` — user-owned; AI не перетирает.
- **Обязательное поведение** (не оптимизации): cascade-delete, graceful shutdown, deep-merge для style/meta, echo-guard, pin discipline, atomic domain mutations + best-effort layout.
- **Daemon-safe room ops:** `flushIfDirty(id) → stat → op`; для restore — evict ПОСЛЕ rename.
- **tldraw 5.x обязателен** — проверять `https://tldraw.dev/docs/editor` перед написанием tldraw-кода.
- **CLI — стабильный machine interface:** меняешь output → обнови integration-тесты + `CHANGELOG.md`.

## Contributing

- Ветки `feature/<name>` / `fix/<name>` / `docs/<name>` от `main`; merge через `--no-ff`; не делать rebase feature-ветки на `main`.
- Commit-сообщения — короткое imperative-описание изменений; без `Co-Authored-By` / `Signed-off-by` / `Generated by` trailers.
- Перед PR: `bun run test` зелёные + `bun run lint` чистый.
