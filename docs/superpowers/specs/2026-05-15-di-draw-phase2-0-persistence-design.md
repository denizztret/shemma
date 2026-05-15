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

### 2.4. Room export/import to JSON file

Простая операция, не зависит от формата (это просто внутренний canvas snapshot, не Mermaid/Miro/etc — те идут в Phase 2.5).

```
didraw rooms export <id> --to path/file.json    # пишет {schemaVersion, canvas, prompts} в файл
didraw rooms import path/file.json [--as <id>]  # читает файл, создаёт room (или перезаписывает)
```

Под капотом — то же, что storage layer пишет на диск. Schema version в header — для будущей миграции (если изменим shape).

Зачем сейчас, а не в Phase 2.5:
- **Backup.** Пользователь хочет сохранить рабочую схему до экспериментов.
- **Cross-folder transfer.** Перенести готовую диаграмму из одного проекта в другой.
- **Sharing minimal.** Коллега запустит свой di.draw и `didraw rooms import received.json` — увидит ту же схему. Это **не** полноценный multi-user, это «отправь файл по любому каналу». Достаточно как baseline до Phase 3 multi-user.

Phase 2.5 добавит export в **другие форматы** (Mermaid/Miro/Figma/SVG/PNG) — это уже трансформация, не транспорт.

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

- `apps/backend/tests/storage-path.test.ts` — слугификация всех вариантов env (`CLAUDE_SESSION_ID` / `CLAUDE_PROJECT_DIR` / fallback).
- `apps/backend/tests/rooms-api.test.ts` — list, use, archive, restore flow; mtime cache invalidation.
- `apps/backend/tests/room-export-import.test.ts` — export → import roundtrip: assert state byte-equality (canvas + prompts), schemaVersion header присутствует, импорт в новый id не перезаписывает существующий без `--force`.
- CLI integration: `didraw rooms list` пустой workspace → `{rooms:[]}`; после `didraw define service auth` → 1 room, 1 element; `rooms export … --to /tmp/x.json && rooms import /tmp/x.json --as restored` → 2 rooms.
- Manual smoke: запустить из двух разных folder'ов одновременно, убедиться что storage dirs разные (не пересекаются).

## 5. Implementation outline (writing-plans будет шире)

1. `config.ts`: env-based slug + fallback chain; tests.
2. `rooms.ts`: cache + scan API (mtime invalidation).
3. `routes/rooms.ts`: list/use/archive/restore endpoints + tests.
4. `routes/rooms-export-import.ts` или extension к §3: file roundtrip + schemaVersion header.
5. CLI: `didraw rooms` subcommand (list/use/archive/restore/export/import).
6. Skill: inject `didraw rooms list` + guidance text.
7. Smoke: dual-folder run + archive/restore roundtrip + export/import roundtrip.
8. CHANGELOG, bump 0.0.1 → 0.1.0.

Estimated: 6-8 tasks.
