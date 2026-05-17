# di.draw Phase 2.2 — Sync Hardening + User-Arrows Design

> **Status:** draft v0.1 — 2026-05-16. Built on Phase 2.1 v0.2.0 (`0af178d`).
>
> **Scope:** roundtrip user-drawn arrows (B1) + durable opLog + version-aware reconnect (ack/replay) + no-silent-fail surface. Plus closure of [[phase-2-0-followups]] и [[phase-2-1-followups]] (отдельный backlog-блок в плане, дизайн не требуется).

## 1. Goals

- **B1 — User arrows round-tripped к backend.** Пользователь рисует стрелку в tldraw, привязывает к узлам → backend получает `Edge` op → все клиенты видят. Сейчас `to-patch.ts:104,138` молча дропает `s.type === "arrow"`.
- **Durable opLog.** `RoomState.opLog` персистится в envelope (capped buffer), чтобы клиент после reconnect получил inкрементальный delta вместо full refetch.
- **Version-aware reconnect (ack/replay).** Клиент трекает `lastVersion`; на reconnect шлёт hello с этой версией; сервер отвечает replay'ем delta или сигналом truncated.
- **No-silent-fail.** Rejected backend patch'и не теряются молча; пользователь видит inline banner. Сейчас `applyPatch` фейлится → frontend пишет в console и не пробует снова — пользовательской обратной связи нет.

**Anti-goals (defer):**
- Multi-user shared editing (CRDT/OT). Phase 3.x.
- Полный event-sourcing journal beyond windowed buffer. Текущий `config.opLogMaxSize` остаётся cap'ом.
- Inline NL→action парсер на backend (L3) — задача LLM.

## 2. B1 — User arrows → backend

### 2.1 Detection in `to-patch.ts:diffToOps`

Текущий цикл `for s of currentShapes` пропускает arrows. Изменения:

1. Снять `if (s.type === "arrow") continue` в обоих местах (add detection + update detection).
2. Для нового arrow shape:
   - Извлечь bindings: tldraw хранит arrow endpoints в `bindings` (`fromId/toId` через `binding.props.terminal`).
   - Если есть `start.boundShapeId` → `Endpoint = {kind:"node", id: boundShapeId}`.
   - Если нет binding'а (free endpoint) → `Endpoint = {kind:"point", x, y}` (Endpoint union в `types.ts:37` уже это поддерживает).
   - Извлечь label (`richText` → plain text helper).
   - Style: `dashed` из tldraw `dash` prop; `arrow: "to"` (default tldraw) или `"both"` если arrowheadStart != "none".
   - Edge id: `tlShapeIdToEdgeId(s.id)` — детерминистический slug, например `s.id` → "shape:c_<tlid>" (через существующий `id-prefix.ts`).
3. Emit `{op:"add", target:"edge", value: {id, from, to, label?, style?}}`.

### 2.2 Update detection

При движении/перепривязке стрелки tldraw меняет binding props или position. Diff детектирует:
- Endpoint move (binding изменился) → `update edge` с новым `from`/`to`.
- Label change → `update edge` с новым label.
- Style change (dashed toggle) → `update edge` с новым style + `meta.styleOwnedBy:"user"`.

### 2.3 Delete detection

`shape:arrow` исчезает в diff → `{op:"delete", target:"edge", id}`.

### 2.4 Roundtrip симметрия

Backend `from-canvas-state.ts:edgeToShape` уже создаёт arrow + bindings. Echo-guard (clientOpId) предотвращает self-loop. Test invariant: send → ws-broadcast → received → diff = []. См. test plan §10.5.

### 2.5 Validation & inference

`/api/patch` route уже принимает `target:"edge"`. Дополнения:
- `inferUserMetadata` (Task 7 Phase 2.1) расширяется на `target:"edge"` updates: style touch → `meta.styleOwnedBy="user"`. Без pin для edge (pin осмыслен только для nodes).
- Connection kind: spec §3.4 пишет `meta.kind` для AI-домена; user-drawn arrow по default не имеет kind — лучше оставить undefined чем угадывать. AI потом может дозаписать через `connect`.

## 3. Durable opLog

### 3.1 Envelope расширение

`PersistedEnvelope` (Phase 2.0) сейчас содержит `{schemaVersion, roomId, version, lastTouched, elementCount, canvas, prompts}`. Bump schemaVersion `1 → 2`. Добавить:

```ts
type PersistedEnvelopeV2 = PersistedEnvelopeV1 & {
  schemaVersion: 2;
  opLog: OpLogEntry[];  // capped at config.opLogMaxSize (current default 50)
};
```

### 3.2 Migration

`parseFull` (apps/backend/src/envelope.ts):
- При чтении `schemaVersion === 1`: возвращаем envelope с `opLog: []` (lossy для existing files; expected).
- При чтении `schemaVersion === 2`: `opLog: parsed.opLog ?? []`.

`serialize`: всегда писать v2 + `opLog: state.opLog.slice(-cap)`.

### 3.3 Load behaviour

`apps/backend/src/persistence.ts` сейчас на load делает `opLog: []`. Заменить на `opLog: envelope.opLog ?? []` для v2 envelope.

### 3.4 Implications

- Сохранённый opLog cap'нут на `opLogMaxSize` (default 50). Длинный disconnect (>50 ops пропущено) → клиент получает `truncated` (§4.3) и refetch full state.
- Backwards-compat: v1 envelope читается, opLog start пустой (новые ops пишутся в журнал через `room.opLog.push` как раньше). После первой write/persist цикла файл апгрейдится до v2.

## 4. Version-aware WS sync (ack/replay)

### 4.1 Client state

`apps/frontend/src/transport/ws.ts` или `App.tsx` трекает `lastReceivedVersion` (изначально 0, updated с каждого ws `patch` message и с каждого начального `getState()`).

### 4.2 WS hello handshake

При open WS connection клиент отправляет первое сообщение:

```ts
ws.send(JSON.stringify({ kind: "hello", lastVersion: lastReceivedVersion }));
```

Сервер (в `bus.attach` callback) читает hello → принимает решение:

```ts
type WsHelloResponse =
  | { kind: "sync-ack"; version: number }       // client up-to-date
  | { kind: "replay"; ops: OpLogEntry[]; version: number }  // delta available
  | { kind: "truncated"; version: number };     // gap > opLog window
```

### 4.3 Server logic

`apps/backend/src/index.ts:websocket.open` сейчас отвечает `{kind:"hello", version: 0}` слепо. Заменить на:

```ts
message(ws, raw) {
  const msg = JSON.parse(raw);
  if (msg.kind === "hello") {
    const r = await rooms.get((ws.data as { room: string }).room);
    const last = msg.lastVersion ?? 0;
    if (last >= r.version) {
      ws.send(JSON.stringify({ kind: "sync-ack", version: r.version }));
    } else {
      const minLogVer = r.opLog[0]?.version ?? r.version;
      if (last + 1 >= minLogVer) {
        const replay = r.opLog.filter(e => e.version > last);
        ws.send(JSON.stringify({ kind: "replay", ops: replay, version: r.version }));
      } else {
        ws.send(JSON.stringify({ kind: "truncated", version: r.version }));
      }
    }
  }
}
```

Текущий `websocket.message() {}` (no-op) заменяется этой логикой.

### 4.4 Client reconnect

`apps/frontend/src/transport/ws.ts` уже делает exponential backoff. Дополнения:
- На `onopen`: отправить hello с `lastReceivedVersion`.
- На `replay`: применить `ops` через `applyPatch` локально (через editor.mergeRemoteChanges), bump `lastReceivedVersion = msg.version`.
- На `truncated`: fetch `GET /api/state` (existing path), reset `lastReceivedVersion` к `r.version`.
- На `sync-ack`: ничего не делать (уже sync).

### 4.5 Backwards-compat

Старые клиенты не шлют hello → сервер видит первое не-hello сообщение либо timeout. Совместимость: если в течение 100ms после ws.open сервер не получил hello, считать `lastVersion: 0` (стрим всё с начала, для legacy). Реализация: setTimeout в `open` handler. Acceptable trade-off.

## 5. No-silent-fail surface

### 5.1 Server-side rejection notification

Когда `/api/patch` или `/api/domain` отдают 422, текущая модель: HTTP response с `{ok:false, error}`. Frontend `api.ts:sendPatch` логирует в console и возвращает результат — UI не показывает.

Дополнения:
1. В `transport/api.ts:sendPatch` (и `sendDomain` если есть): на `!ok` положить error в global error bus / store.
2. Новый UI компонент `chrome/ErrorBanner.tsx` — top-right toast, показывает последние 3 errors, auto-dismiss 5s. Скрин: tldraw остаётся primary UI, banner — service-layer per spec §3.8.
3. WS-side: server **не** шлёт WS error message (origin client получил HTTP error, остальные клиенты не должны видеть чужие rejection'ы — это privacy/UX-better).

### 5.2 Frontend ErrorBanner

```tsx
// apps/frontend/src/chrome/ErrorBanner.tsx
export function ErrorBanner({ errors }: { errors: Array<{at: number, text: string}> }) {
  // renders top-right column of toasts; CSS: position absolute, max-width 320, opacity transition
}
```

Слушает callback'и из transport layer; auto-removes по timer.

## 6. Followups (закрытие)

См. [[phase-2-0-followups]] и [[phase-2-1-followups]]. Дизайн не требуется — это targeted fixes. План закрывает:

**Phase 2.0 Important:**
- I1 slug length cap
- I2 import explicit flushIfDirty
- I3 409 untouched test
- I4 workspace isolation tests
- I5 409 import response `existingId`

**Phase 2.0 Minor:**
- m1 GET /api/rooms filename id validation
- m3 parseFull types
- m4 WS upgrade room validation
- m5 evictIdle → flushIfDirty
- m6 config lazy-singleton reset для тестов

**Phase 2.1 Important:**
- I1 ~87 tsc `--noEmit` warnings (`noUncheckedIndexedAccess` violations)
- I2 idempotency cache LRU (bounded, default max 1000)

**Phase 2.1 Minor:**
- m1 double `bus.publish` per /api/domain — solution: combined publish OR explicit two-phase comment (предпочтительно: explicit comment, current behavior корректен для echo-guard)
- m2 `nodeToCompact` default role `"service"` для unknown — solution: omit role field if undefined (TS optional)
- m3 dead export `connectionPropsForEdge` — apply в `edgeToShape` или удалить

## 7. Test strategy

### 7.1 New invariants

- **B1 roundtrip:** user draws arrow → backend Edge op → all clients render arrow with same endpoints. Test: subprocess CLI + Playwright (если есть; иначе integration tests).
- **opLog persistence:** restart daemon → reconnect client с `lastVersion=N` → получает replay delta. Backend integration test.
- **WS hello:** client connects without hello → 100ms timeout → server sends initial state via legacy path. Backend test.
- **Truncated reconnect:** opLog cap=5; client missed 10 ops → server sends `truncated`; client refetches state. Backend integration test.
- **Error banner:** invalid patch → HTTP 422 → frontend banner shows. UI smoke (если Playwright поднят в этом плане).

### 7.2 Existing test impact

- Phase 2.0 envelope tests: bump schemaVersion 1→2 в seed test data; backward-compat test (read v1 → opLog: []).
- Phase 2.1 routes tests: invariants по `bus.publish` остаются те же (WS логика расширяется, не меняется существующее).

## 8. Versioning

- v0.3.0 (since B1 + sync hardening are user-visible features beyond a patch). 
- Schema bump from 1 → 2 documented в CHANGELOG.

## 9. Out of scope / Backlog

- **Cursor sharing / awareness** (Phase 3 multi-user).
- **Server-pushed rejection broadcasts** к non-origin clients (privacy concern).
- **OpLog full event-sourcing** beyond windowed buffer.
- **Compression of replay ops** для big-gap reconnects.

---

**Linked:** [[di-draw-project]], [[phase-2-0-followups]], [[phase-2-1-followups]]
