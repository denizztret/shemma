# di.draw Phase 2.0 — Persistence hardening

> **Status:** design (v1.1, 2026-05-15) — pending user review
> **Revision history:** v1 (2026-05-15) — session-scoped storage; v1.1 (2026-05-15) — после review: workspace-scoped storage / session-scoped room, daemon-safe ops, drop `rooms use`, explicit `--force` semantics, collision-resistant slugify.
> **Scope:** minimal pre-2.1 prerequisite. Закрывает P3 + добавляет rooms discovery, чтобы Phase 2.1 (Agent v2) при старте сессии видел уже существующие схемы из текущей папки.

## 1. Зачем сейчас, отдельно от 2.1

Spec v3.7 §3.5 обещает per-session canvas isolation через `~/.claude/projects/<slug>/canvas/<room>.json`. Реальность (known-issues P3): `CLAUDE_SESSION_ID` env не учитывается, release binary валит всё в общий `default-project/canvas/`.

Без этого фикса:
- Старые схемы из старых сессий смешиваются.
- AI при `/draw` invocation не понимает, какие схемы уже существуют для этого workspace.
- Continuing a previous session невозможно без manual `--room` argument.

Phase 2.1 (domain agent) принимает решения «продолжаем существующую схему или новую» на основе context. Поэтому **persistence сначала**.

## 2. Что делаем

### 2.1. Workspace-scoped storage / session-scoped room

**Главная инверсия относительно v1**: storage директория определяется **проектом**, а не сессией. `CLAUDE_SESSION_ID` влияет только на default room name внутри этой директории. Это позволяет новой сессии в той же папке увидеть схемы старых сессий — что и есть цель `rooms discovery`.

```
storageDir = ~/.claude/projects/<projectSlug>/<canvas | canvas-dev>/
roomFile   = <storageDir>/<roomId>.json
```

#### Project slug resolution chain (новый, в `config.ts`)

```ts
projectSlug =
  process.env.DIDRAW_PROJECT_DIR ??   // explicit override (testing, multi-project)
  process.env.CLAUDE_PROJECT_DIR ??   // Claude Code пробрасывает абсолютный путь workspace
  process.cwd() ??                    // fallback на текущую рабочую директорию
  "default-project";

projectSlug → slugify → safe path segment
```

#### Slugify rules

- Lowercase.
- `/`, `\` → `-`.
- Remove leading/trailing `-`.
- Collapse runs of `-`.
- **Collision-resistant suffix**: финальный slug = `slugBody + "-" + sha1(originalInput).slice(0,8)`. Это гарантирует, что разные пути с одинаковой sluggified-частью (`/home/u1/proj` и `/home/u2/proj`) не сольются в одну директорию.

#### Room id resolution chain (новый, в backend route handler + frontend transport)

```
roomId =
  explicit CLI arg --room <id>    OR
  URL ?room=<id>                  OR
  process.env.CLAUDE_SESSION_ID   OR
  "default"
```

Validation: roomId должен матчить `/^[a-zA-Z0-9_-]{1,64}$/`. Не-matching id → **422 error**, не silent mangle (UX явный — пользователь увидит, что не так с именем).

#### Что **не** делаем (v1)

- **`rooms use`** — отвергнут (option 1 из user review). Skрытое active-state создаёт расхождение между CLI и browser tab. Если пользователь хочет продолжить старую схему — `didraw open <roomId>` или `--room <id>`. Никаких persistent active-marker'ов.

### 2.2. Rooms API — daemon-safe

**Все операции с rooms идут через backend HTTP API** (не прямой filesystem из CLI). Сейчас `packages/didraw-cli/src/lifecycle.ts` делает `copyFileSync`/`unlinkSync` напрямую от диска — это **stale**: daemon держит state в памяти с `autosaveDebounceMs: 300` (см. `apps/backend/src/config.ts:62`). Между mutation и debounce flush файл устаревший. v1.1 закрывает это.

```
GET    /api/rooms                      # list { rooms: [{id, lastTouched, elementCount, version}] }
POST   /api/rooms/:id/export           # body: {to: <absolute-path>}; flushes dirty state, returns {ok, path, schemaVersion}
POST   /api/rooms/import               # body: {from: <path>, as?: <id>, force?: boolean}
POST   /api/rooms/:id/archive          # flushes, evicts from memory, moves to <storageDir>/.archive/
POST   /api/rooms/:id/restore          # moves back from .archive/
DELETE /api/rooms/:id                  # hard delete; requires {confirm:true} body
```

#### Daemon-safe invariants

Каждая операция в backend следует одному шаблону:

1. `await rooms.flushIfDirty(id)` — сбрасывает in-memory state в файл, синхронно.
2. `await rooms.evict(id)` — удаляет room из памяти, если был загружен. Следующий запрос к нему перечитает с диска.
3. Выполняется файловая операция (copy/move/unlink).
4. Если impl ошиблась — структура persistence не повреждена, потому что (1) и (2) идемпотентны.

`flushIfDirty` уже частично существует в backend (autosave debounce таймер), но публичного API для синхронного flush сейчас нет. Phase 2.0 его добавляет в `apps/backend/src/rooms.ts`.

#### Metadata listing

`GET /api/rooms` сканирует `<storageDir>/*.json`. Для каждого файла читает **только header**: первые ~2KB или явный `{schemaVersion, version, elementCount, lastTouched}` блок в начале payload. Без full-parse — это для 100 rooms не должно быть медленнее ~50ms. Cache: in-memory dict с mtime check; реcканируется при изменении любого файла в директории.

### 2.3. CLI surface

```
didraw rooms list                                # via GET /api/rooms
didraw rooms export <id> --to <path>             # via POST /api/rooms/:id/export
didraw rooms import <path> [--as <id>] [--force] # via POST /api/rooms/import
didraw rooms archive <id>                        # via POST /api/rooms/:id/archive
didraw rooms restore <id>                        # via POST /api/rooms/:id/restore
didraw rooms rm <id> --confirm                   # via DELETE /api/rooms/:id
```

`--room <id>` arg на data commands (state/patch/define/...) продолжает работать как room override. Default — `CLAUDE_SESSION_ID` env или `"default"`.

Существующий `lifecycle.ts` (методы `exportRoom`, `rmRoom`, `list`) переделывается: вместо `copyFileSync`/`unlinkSync` — HTTP вызовы. Backwards-compat: command signatures сохраняются.

### 2.4. Room export/import — semantics

Простой transport, не трансформация. Mermaid/Miro/Figma — это Phase 2.5.

#### Export schema

```json
{
  "schemaVersion": 1,
  "exportedAt": "2026-05-15T12:00:00Z",
  "roomId": "<original id>",
  "version": 42,
  "canvas": { "version": 1, "nodes": [...], "edges": [...], "groups": [...] },
  "prompts": [...]
}
```

`version` (op-counter, не schema) обязателен — чтобы import восстанавливал byte-equivalent state, иначе incremental sync поломается.

#### Overwrite semantics

`POST /api/rooms/import`:
- `force: false` (default): если target id уже существует → 409 `{ok:false, error:"room exists", existingId}`.
- `force: true`: target room **flushed + evicted** (чтобы daemon не перезаписал импорт следующим autosave), затем файл заменяется.

CLI: `--force` flag явный, без него — exit 1 с понятной ошибкой.

#### Зачем сейчас, а не в Phase 2.5

- **Backup.** До экспериментов сохранить рабочую схему.
- **Cross-folder transfer.** Перенести готовую схему между проектами.
- **Sharing minimal.** «Отправь файл по любому каналу», коллега `didraw rooms import received.json`. Не multi-user, но baseline до Phase 3.

Phase 2.5 — это **трансформации** (Mermaid/Miro/Figma/SVG/PNG), которые потеряют domain fidelity. Native JSON остаётся как round-trip-safe transport.

### 2.5. Skill startup awareness

В `.claude/skills/draw/SKILL.md` добавляем injected section:

```
## Rooms in this workspace

!`didraw rooms list 2>/dev/null || echo '{"rooms":[]}'`
```

AI на старте `/draw` видит:
```json
{"rooms": [
  {"id": "design-v1", "lastTouched": "2026-05-10T12:00:00Z", "elementCount": 12, "version": 47},
  {"id": "default",   "lastTouched": "2026-05-15T08:30:00Z", "elementCount": 0,  "version": 0}
]}
```

И в человеческой части skill — рекомендация:

> «Если в `rooms` есть непустые схемы и они релевантны текущему диалогу — спроси у пользователя, продолжаем существующую или начинаем новую. Не загромождай default-room случайными ad-hoc диаграммами.»

## 3. Scope-out

- **Cross-project rooms.** Rooms scoped по `<storageDir>` (folder). Cross-folder transfer — через `rooms export/import` (§2.4), а не shared-mount.
- **Cloud sync, shared rooms.** Phase 3.
- **Room renaming.** v1 — archive + restore-as-other-name. Direct rename — backlog.
- **Export в другие форматы** (Mermaid/Miro/Figma/SVG/PNG). Phase 2.5. Здесь — только native JSON snapshot для backup/sharing.

## 4. Tests

### 4.1. Project-slug and room-id resolution

- **slugify**:
  - `/home/u1/proj` и `/home/u2/proj` (одинаковый basename, разные пути) → различные slugs (collision hash суффикс).
  - Spaces, unicode, deep paths — все продуцируют valid path segments.
  - Empty input → fallback `"default-project"`.
- **project slug chain**: only DIDRAW_PROJECT_DIR → only CLAUDE_PROJECT_DIR → only cwd → fallback. Каждый шаг с приоритетом.
- **room id validation**: `auth-v2` accepted, `auth v2` (space) rejected with 422, `../etc/passwd` rejected with 422, empty rejected.

### 4.2. Workspace isolation

- **Two sessions same workspace see same room list.** Spawn daemon из folder `/A` с session1; create room `design`. Спавн второй daemon (или re-init) из той же `/A` с session2; `rooms list` показывает `design`. Default room по session id различается, но обе сессии видят `design`.
- **Different workspaces, isolated storage.** `/A` и `/B` ни в каком случае не делят rooms.

### 4.3. Daemon-safe ops

- **Dirty flush on export.** Apply mutation (room status dirty, ещё не autosaved); `rooms export` → exported file содержит mutation. Wait `autosaveDebounceMs+50`, повторный export — byte-equal с предыдущим.
- **No autosave overwrite after delete.** Apply mutation, `rooms rm --confirm`, wait > `autosaveDebounceMs` — файл не воссоздан daemon'ом.
- **Import overwrite without --force.** Import to existing id → 409, original room untouched.
- **Import overwrite with --force.** Import to existing id с force=true → target room flushed, evicted, заменён; new room reflects imported data.

### 4.4. Export/import roundtrip

- Export → import roundtrip: assert canvas+prompts byte-equality, version field присутствует в файле, после import roomState.version совпадает с exported.
- Schema version mismatch: import file with `schemaVersion: 999` → 422 c `"unsupported schemaVersion"`.

### 4.5. CLI integration

- `didraw rooms list` пустой workspace → `{rooms:[]}`.
- После `didraw define service auth` → `rooms list` показывает 1 room.
- `didraw rooms export … --to /tmp/x.json && didraw rooms import /tmp/x.json --as restored --force` → 2 rooms.

## 5. Implementation outline

1. `config.ts`: project slug resolution (DIDRAW_PROJECT_DIR → CLAUDE_PROJECT_DIR → cwd → "default-project") + collision-resistant slugify. Tests §4.1.
2. `rooms.ts`: room id validation, `flushIfDirty(id)`, `evict(id)` public API. Tests §4.2-§4.3 invariants.
3. `routes/rooms.ts`: list endpoint (header-only scan + mtime cache) + tests.
4. `routes/rooms.ts`: archive/restore endpoints (daemon-safe pattern) + tests.
5. `routes/rooms.ts`: export endpoint (flush → emit schema-versioned JSON) + tests.
6. `routes/rooms.ts`: import endpoint (force semantics) + tests §4.4.
7. CLI `lifecycle.ts` rewrite: replace direct filesystem with HTTP-via-daemon. Tests §4.5.
8. Skill SKILL.md: inject `didraw rooms list` + guidance.
9. CHANGELOG, bump 0.0.1 → 0.1.0.

Estimated: 7-9 tasks (немного больше из-за daemon-safe rewrite существующего `lifecycle.ts`).
