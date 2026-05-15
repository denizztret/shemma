# di.draw Phase 2.0 — Persistence hardening

> **Status:** design (v1, 2026-05-15) — pending user review
> **Scope:** minimal pre-2.1 prerequisite. Закрывает P3 + добавляет rooms discovery, чтобы Phase 2.1 (Agent v2) при старте сессии видел уже существующие схемы из текущей папки.

## 1. Зачем сейчас, отдельно от 2.1

Spec v3.7 §3.5 обещает per-session canvas isolation через `~/.claude/projects/<slug>/canvas/<room>.json`. Реальность (known-issues P3): `CLAUDE_SESSION_ID` env не учитывается, release binary валит всё в общий `default-project/canvas/`.

Без этого фикса:
- Старые схемы из старых сессий смешиваются.
- AI при `/draw` invocation не понимает, какие схемы уже существуют для этого workspace.
- Continuing a previous session невозможно без manual `--room` argument.

Phase 2.1 (domain agent) принимает решения «продолжаем существующую схему или новую» на основе context. Поэтому **persistence сначала**.

## 2. Что делаем

### 2.1. Закрыть P3 — `CLAUDE_SESSION_ID` → storage path

`apps/backend/src/config.ts:50-57` сейчас hard-codes `"default-project"`. Меняем на:

```ts
const slug = process.env.CLAUDE_SESSION_ID
  ? slugify(process.env.CLAUDE_SESSION_ID)
  : process.env.CLAUDE_PROJECT_DIR
    ? slugify(process.env.CLAUDE_PROJECT_DIR)
    : "default-project";
```

Где `slugify` — детерминированный path-safe slug (нижний регистр, заменить `/` на `-`, обрезать leading dashes).

`CLAUDE_PROJECT_DIR` — env, который Claude Code пробрасывает с абсолютным path workspace. Если `CLAUDE_SESSION_ID` нет (например пользователь дёрнул `didraw` напрямую из shell), fallback на dir-based slug — тоже стабильно per-folder.

### 2.2. Rooms API

Добавить:

```
GET  /api/rooms          # list { rooms: [{id, lastTouched, elementCount, version}] }
POST /api/rooms/:id/use  # switch active room для default-room fallback (writes lastUsed marker)
DELETE /api/rooms/:id    # archive — moves файл в <storageDir>/.archive/, keeps for grep
```

Backend сканирует `<storageDir>/*.json`, читает метаданные без полной загрузки (только version + elementCount + mtime). Cache invalidation — на mtime check, реcканируется при изменении.

### 2.3. CLI

```
didraw rooms list                 # JSON: [{id, lastTouched, elementCount, version}]
didraw rooms use <id>             # установить activeRoom для текущей папки
didraw rooms archive <id>         # переместить в .archive/
didraw rooms restore <id>         # из .archive/ обратно
```

Сохраняем backward compatibility: `--room <id>` arg на всех data commands продолжает работать как override.

### 2.4. Skill startup awareness

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

- **Cross-project rooms.** Rooms scoped по `<storageDir>` (folder). Перенос между folders — manual.
- **Cloud sync, shared rooms.** Phase 3.
- **Room renaming.** v1 — archive + restore-as-other-name. Direct rename — backlog.
- **Room export/import** (single-file save/load). Phase 2.5 (export фича).

## 4. Tests

- `apps/backend/tests/storage-path.test.ts` — слугификация всех вариантов env.
- `apps/backend/tests/rooms-api.test.ts` — list, use, archive flow; mtime cache invalidation.
- CLI integration: `didraw rooms list` пустой workspace → `{rooms:[]}`; после `didraw define service auth` → 1 room, 1 element.
- Manual smoke: запустить из двух разных folder'ов одновременно, убедиться что storage dirs разные.

## 5. Implementation outline (writing-plans будет шире)

1. `config.ts`: env-based slug; tests for fallback chain.
2. `rooms.ts`: cache + scan API.
3. `routes/rooms.ts`: list/use/archive endpoints + tests.
4. CLI: `didraw rooms` subcommand.
5. Skill: inject `didraw rooms list` + guidance text.
6. Smoke: dual-folder run + archive/restore roundtrip.
7. CHANGELOG, bump 0.0.1 → 0.1.0.

Estimated: 5-7 tasks.
