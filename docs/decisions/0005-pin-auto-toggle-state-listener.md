# ADR-0005: Pin auto-toggle — state machine listener choice

## Context

DRW-185 требует детектировать переход `select.translating`/`select.resizing` → `select.idle`,
чтобы автоматически снимать pin с перетащенных/ресайзнутых фигур и восстанавливать его после.

## Decision

Использовать `react()` из `@tldraw/state` (доступен через `import { react } from "tldraw"`)
с подпиской на `editor.getPath()` — `@computed` сигнал.

## Rationale

**Почему `react()` + `editor.getPath()`:**

- `Editor.getPath()` декорирован `@computed` (подтверждено в `@tldraw/editor` dist-cjs/lib/editor/Editor.js, строка `__decorateClass([import_state.computed], Editor.prototype, "getPath", 1)`).
- `StateNode._path` — тоже `computed` сигнал (строка `this._path = computed("toolPath" + this.id, ...)`), `getPath()` вызывает `this._path.get()`.
- Вызов `editor.getPath()` внутри `react()` callback автоматически создаёт реактивную подписку; callback перевызывается при каждой смене state path.
- `react()` возвращает disposer `() => void` — стандартный паттерн codebase (см. `registerAutoFlipDirection`, `registerStyleDefaultsSync`).
- Импорт через `"tldraw"` (не через `"@tldraw/state"` напрямую) — тип проверен: `tldraw` реэкспортирует `@tldraw/editor`, который реэкспортирует `@tldraw/state` (`export * from "@tldraw/state"`).

**Альтернативы отклонены:**

- `editor.on('event', handler)` — менее стабильный low-level event bus, см. memory `feedback-tldraw-docs`.
- `editor.store.listen(...)` — подходит для изменений данных (records), но не для state machine transitions.
- `editor.sideEffects.registerBefore*` — только для record mutations.

## Observed state paths

Выведены из source analysis (`StateNode._path = computed(...)` → dotted join через active children):

- Idle: `select.idle`
- Начало перетаскивания: `select.pointing_shape` → `select.translating`
- Конец перетаскивания: `select.translating` → `select.idle`
- Начало ресайза: `select.pointing_resize_handle` → `select.resizing`
- Конец ресайза: `select.resizing` → `select.idle`

*Live browser verification deferred — controller agent проверяет в Task 5 Phase 5/Step 6.*

## Implementation pattern (для Task 5)

```typescript
import { react, type Editor } from "tldraw";

export function registerPinAutoToggle(editor: Editor): () => void {
  let prevPath = "";
  return react("pin-auto-toggle", () => {
    const path = editor.getPath();
    if (path === prevPath) return;
    const prev = prevPath;
    prevPath = path;

    const isEntering = (s: string) => path === s && prev !== s;
    const isLeaving = (s: string) => prev === s && path !== s;

    if (isEntering("select.translating") || isEntering("select.resizing")) {
      // open session: запомнить pinned shapes
    }
    if (isLeaving("select.translating") || isLeaving("select.resizing")) {
      // close session: снять pin → backend → восстановить pin
    }
  });
}
```

Wire в `App.tsx onMount` аналогично `registerAutoFlipDirection` (хранить ref, cleanup в `useEffect` return).

## Consequences

- Detection logic — чистое path-сравнение без DOM events.
- Нет polling, нет setTimeout — реактивный сигнал срабатывает синхронно при смене state.
- Disposer-pattern совместим с HMR и room-switch cleanup.
