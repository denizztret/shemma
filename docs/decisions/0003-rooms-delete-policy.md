# ADR-0003: Rooms delete policy — archive default, hard delete explicit

**Date:** 2026-05-17
**Status:** Decided
**Blocks:** DRW-031, DRW-034, DRW-029
**Refs:** [[feedback-product-vision-bidirectional]], DRW-035 (linkage detection), DRW-039 (`/api/session`)

## Context

Phase 3.0 архитектурный pivot оформил рабочую модель: **rooms — это визуализация мыслей и архитектуры, не source of truth**. SoT остаётся диалог с агентом плюс исходники проекта; room — derived visual projection поверх них. Теоретически любая комната восстановима из диалога.

На практике, однако:

1. Через 2 месяца перерисовать complex visual context — это десятки минут работы. Replicability ≠ free.
2. Если room привязана к активной сессии Claude Code (`CLAUDE_SESSION_ID === roomId`), агент может ссылаться на её содержимое как на анкор. Удаление такой комнаты по ошибке стирает контекст работы агента.
3. Текущий `DELETE /api/rooms/:id { confirm: true }` делает hard unlink моментально, без warning. CLI `didraw rooms rm <id>` — то же самое.

Phase E (Rooms Gallery, DRW-029) добавляет web UI для каталога комнат. В UI delete будет лёгким (one click + confirm dialog). Принцип: чем легче триггерить, тем дороже recovery без подстраховки. Нужна явная политика, фиксирующая баланс convenience vs safety.

## Decision

**Layered delete:** archive by default, hard delete only as explicit power-user step.

| Layer | UI action | CLI command | Effect | Linked check |
|-------|-----------|-------------|--------|--------------|
| Soft (UI default) | Delete | `didraw rooms archive <id>` (existing) | move file to `.archive/` (atomic rename) | warning if linked, no block |
| Hard (UI explicit) | Delete permanently (only from Archive view) | `didraw rooms rm <id> --hard --confirm` | actual unlink | 409 if linked to active session, bypass with `--force` |
| Hard bulk | Empty archive (button in Archive view) | `didraw rooms purge-archive --confirm` | unlink all in `.archive/` | none (already archived) |

### Linkage detection (implicit, MVP)

`Room.meta.linkedSession?: string` — выставляется автоматически при создании комнаты если `CLAUDE_SESSION_ID === roomId` в момент `Rooms.get()`. Никакого explicit `rooms link` CLI; explicit вариант — follow-up (см. «Not covered»).

`GET /api/rooms` отдаёт `linkedSession` в каждом item. Gallery рендерит badge "linked". CLI `--hard` без `--force` для linked комнаты → 409 `linked-to-active-session`.

### Undo window (UI only)

После archive в UI: toast "Moved to archive — Undo (5s)". Если user кликает Undo в течение 5s, делается reverse: rename из `.archive/` обратно. Если нет — toast исчезает и archive persists. Window короткий, потому что archive обратим (любой момент через "Restore from archive"); undo нужен для "I clicked the wrong card" мгновенной коррекции.

CLI undo не реализуется (CLI users знают что делают; `rooms restore` уже существует).

### CLI semantics — Variant A (no breaking change)

`didraw rooms rm <id>` **остаётся hard delete** (как сейчас), backward-compat preserved. Soft delete делается через `didraw rooms archive <id>` (тоже как сейчас). UI default == archive, но это не транслируется на CLI семантику. Closes DRW-034 with rationale: CLI users = power users, automation скрипты могут полагаться на текущую семантику; меняем дефолт UI, не CLI.

### Hard delete на linked room

Power user может удалить даже linked, но через двойной explicit:
- UI: только из Archive view, после прохождения soft-delete. То есть «удалить permanently linked active» в один клик невозможно — сначала archive, потом permanently delete.
- CLI: `--hard --force --confirm` — три флага, фактически невозможно случайно набрать. Без `--force` — 409.

## Why

1. **Cost asymmetry.** Cost(archive then restore) ≈ 0 (один rename). Cost(hard delete by mistake then redraw 100 shapes из диалога) ≈ 30 min. Asymmetry justifies дороже-на-explicit policy.
2. **UI footguns ≠ CLI footguns.** Browser drag/touch может сгенерировать accidental click; терминальная команда требует осознанного набора. Default = archive in UI снимает класс ошибок, который в CLI просто не существует.
3. **Session linkage = anchor warning, not block.** Linked room не immutable — user может явно сказать «удали даже это». Block (hard 409) — только под высокий риск (hard delete без force на active session). Это minimum viable safety, не over-engineering.
4. **Implicit linkage scales.** В MVP CC user обычно делает 1-2 комнаты per session. Implicit detection через `roomId === CLAUDE_SESSION_ID` ловит 90% случаев zero-friction. Edge cases (rename, scratch rooms) — fallback на «нет linkage badge», ничего не ломает.

## Consequences

### Backend

- `DELETE /api/rooms/:id` принимает `{ confirm: true, mode?: 'archive' | 'hard', force?: boolean }`. Default `mode: 'archive'`. `mode: 'hard'` без `force` и `linkedSession === current CLAUDE_SESSION_ID` → 409.
- `POST /api/rooms/purge-archive { confirm: true }` — новый endpoint, hard unlink всех в `.archive/`. Linked check не выполняется (room уже в архиве — значит был explicit archive step ранее).
- `Room.meta.linkedSession?: string` — поле автоматически проставляется в `Rooms.get()` если matches env.
- `GET /api/rooms` response items включают `linkedSession`.

### Frontend (Gallery UI — DRW-029+)

- Delete card action → `DELETE /api/rooms/:id { confirm: true }` (mode default archive), toast с Undo (5s timer + abort flag).
- Archive view filter: per-card "Delete permanently" с modal warning ("This cannot be undone").
- Archive view: "Empty archive" кнопка (purge-archive endpoint).
- `linked` badge на cards где `linkedSession === current session` (из `/api/session` — DRW-039).
- Hard delete на linked → warning modal: «This room is anchored to your active Claude Code session. The agent's visual context may be lost. Type the room id to confirm.» (typing confirm = power-user pattern, защита от accidental click через два modal'а).

### CLI

- `didraw rooms rm <id>` — **unchanged** (hard delete). Old behavior preserved.
- `didraw rooms rm <id> --hard --force --confirm` — hard delete linked room, bypass 409.
- `didraw rooms archive <id>` — unchanged.
- `didraw rooms purge-archive --confirm` — new command, calls `POST /api/rooms/purge-archive`.

### Test coverage required

- Backend: `routes/rooms.test.ts` — DELETE mode=archive (default), mode=hard, mode=hard linked without force → 409, mode=hard linked with force → 200, purge-archive.
- Backend: `rooms.test.ts` — linkedSession auto-set when env matches.
- CLI: integration test — `rooms rm --hard` без force на linked → exit code !=0; `rooms purge-archive` calls endpoint.

## Not covered (future ADRs)

- **Cross-workspace privacy.** Gallery in cross-workspace mode (DRW-032) показывает rooms from other projects. Какие meta полей видны (label/preview) при cross-workspace listing? Не критично для MVP single-workspace gallery; отдельный ADR если потребуется.
- **Explicit linkage (`rooms link <id> --to-session`).** Implicit pattern достаточен в MVP. Если появятся multi-room sessions или rename-after-link — добавим explicit linkage в follow-up задаче.
- **Retention policy.** Авто-archive стars rooms (DRW-038) — отдельная политика, лежит вне scope этого ADR.
- **Permanent log of deleted rooms.** Не пишется. После hard delete — gone. Если в будущем потребуется audit log, добавим как opt-in.

## Decision quality / revisit triggers

Revisit этот ADR если:

1. Появляются automation скрипты, ожидающие `rooms rm` = archive (т.е. Variant B становится привлекательнее) → пересмотреть CLI semantics.
2. User reports «я accidentally удалил important room» — увеличить undo window или добавить explicit linkage (Variant B linkage detection).
3. Cross-device sync вводится — archive folder может потребовать sync rules.
